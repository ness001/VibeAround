//! Short-lived, single-use QR pairing tickets, independent of IM pairing.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use super::AuthToken;

pub const TICKET_TTL_SECS: u64 = 60;
const MAX_PENDING_TICKETS: usize = 64;
static STORE: LazyLock<Mutex<HashMap<String, TicketEntry>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

struct TicketEntry {
    owner: AuthToken,
    audience: String,
    expires_at: Instant,
}

#[derive(Debug, PartialEq, Eq)]
pub enum GenerateError {
    TooManyPending,
}

/// Bind a random ticket to this daemon owner generation and public Host authority.
pub fn generate(owner: &AuthToken, audience: &str) -> Result<String, GenerateError> {
    let mut store = STORE.lock().unwrap();
    purge_expired(&mut store);
    if store.len() >= MAX_PENDING_TICKETS {
        return Err(GenerateError::TooManyPending);
    }
    let ticket = loop {
        let candidate = AuthToken::generate().as_str().to_string();
        if !store.contains_key(&candidate) {
            break candidate;
        }
    };
    store.insert(
        ticket.clone(),
        TicketEntry {
            owner: owner.clone(),
            audience: audience.to_string(),
            expires_at: Instant::now() + Duration::from_secs(TICKET_TTL_SECS),
        },
    );
    Ok(ticket)
}

/// Consume only after all bindings match, under the same lock as the lookup.
pub fn redeem(ticket: &str, owner: &AuthToken, audience: &str) -> bool {
    if ticket.len() != 64
        || !ticket
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return false;
    }
    let mut store = STORE.lock().unwrap();
    purge_expired(&mut store);
    let matches = store.get(ticket).is_some_and(|entry| {
        entry.owner.matches(owner.as_str()) && entry.audience.eq_ignore_ascii_case(audience)
    });
    if matches {
        store.remove(ticket);
    }
    matches
}

fn purge_expired(store: &mut HashMap<String, TicketEntry>) {
    let now = Instant::now();
    store.retain(|_, entry| entry.expires_at > now);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier};

    static TEST_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn tickets_are_random_single_use_and_owner_bound() {
        let _guard = TEST_LOCK.lock().unwrap();
        STORE.lock().unwrap().clear();
        let owner = AuthToken::generate();
        let ticket = generate(&owner, "phone.example:8443").unwrap();
        assert_eq!(ticket.len(), 64);
        assert!(ticket.bytes().all(|b| b.is_ascii_hexdigit()));
        assert_ne!(ticket, owner.as_str());
        let second = generate(&owner, "phone.example:8443").unwrap();
        assert_ne!(ticket, second);
        assert!(!redeem(
            &ticket,
            &AuthToken::generate(),
            "phone.example:8443"
        ));
        assert!(!redeem(&ticket, &owner, "other.example:8443"));
        assert!(!redeem(&ticket, &owner, "phone.example"));
        assert!(redeem(&ticket, &owner, "PHONE.example:8443"));
        assert!(!redeem(&ticket, &owner, "phone.example:8443"));
    }

    #[test]
    fn expired_tickets_are_purged_and_capacity_is_recovered() {
        let _guard = TEST_LOCK.lock().unwrap();
        STORE.lock().unwrap().clear();
        let owner = AuthToken::generate();
        let tickets = (0..MAX_PENDING_TICKETS)
            .map(|_| generate(&owner, "phone.example").unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            generate(&owner, "phone.example"),
            Err(GenerateError::TooManyPending)
        );
        {
            let mut store = STORE.lock().unwrap();
            for entry in store.values_mut() {
                entry.expires_at = Instant::now();
            }
        }
        assert!(!redeem(&tickets[0], &owner, "phone.example"));
        assert!(STORE.lock().unwrap().is_empty());
        assert!(generate(&owner, "phone.example").is_ok());
    }

    #[test]
    fn issuance_purges_expired_entries() {
        let _guard = TEST_LOCK.lock().unwrap();
        STORE.lock().unwrap().clear();
        let owner = AuthToken::generate();
        let ticket = generate(&owner, "phone.example").unwrap();
        STORE.lock().unwrap().get_mut(&ticket).unwrap().expires_at = Instant::now();
        assert!(generate(&owner, "phone.example").is_ok());
        assert!(!STORE.lock().unwrap().contains_key(&ticket));
    }

    #[test]
    fn malformed_tickets_do_not_consume_pending_entries() {
        let _guard = TEST_LOCK.lock().unwrap();
        STORE.lock().unwrap().clear();
        let owner = AuthToken::generate();
        let ticket = generate(&owner, "phone.example").unwrap();
        for candidate in ["", "xyz", &"g".repeat(64), &format!(" {ticket}")] {
            assert!(!redeem(candidate, &owner, "phone.example"));
        }
        assert!(redeem(&ticket, &owner, "phone.example"));
    }

    #[test]
    fn concurrent_redemptions_have_exactly_one_winner() {
        let _guard = TEST_LOCK.lock().unwrap();
        STORE.lock().unwrap().clear();
        let owner = AuthToken::generate();
        let ticket = generate(&owner, "phone.example").unwrap();
        let barrier = Arc::new(Barrier::new(8));
        let workers = (0..8)
            .map(|_| {
                let owner = owner.clone();
                let ticket = ticket.clone();
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    redeem(&ticket, &owner, "phone.example")
                })
            })
            .collect::<Vec<_>>();
        let successes = workers
            .into_iter()
            .filter_map(|worker| worker.join().unwrap().then_some(()))
            .count();
        assert_eq!(successes, 1);
    }
}
