//! Session-local controls. A context window here is a compaction budget, not a model limit.

use agent_client_protocol::schema::v1 as acp;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const CONTEXT_WINDOW_CONFIG_ID: &str = "vibearound.context_window";
pub const CONTEXT_WINDOW_CHOICES: [u64; 4] = [100_000, 200_000, 500_000, 1_000_000];

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionPreferences {
    #[serde(default)]
    pub context_window: Option<u64>,
    #[serde(default)]
    pub config_options: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Default)]
pub(super) struct SessionMetadata {
    pub prepared: bool,
    pub config_options: Vec<acp::SessionConfigOption>,
    pub modes: Option<acp::SessionModeState>,
    pub effort_default: Option<String>,
    pub context_window_default: Option<u64>,
    pub context_window_automatic: bool,
    pub local_defaults: Option<ClaudeDefaults>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub(super) struct ClaudeDefaults {
    #[serde(default)]
    sources: Vec<ClaudeSettingsSource>,
    effort_env: Option<String>,
    context_env: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct ClaudeSettingsSource {
    effort: Option<String>,
    context: Option<serde_json::Value>,
    #[serde(default)]
    models: BTreeMap<String, ClaudeModelSettings>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct ClaudeModelSettings {
    effort: Option<String>,
}

impl ClaudeDefaults {
    fn effort(&self, model: Option<&str>) -> Option<String> {
        let model = model.map(|model| model.strip_suffix("[1m]").unwrap_or(model));
        let value = self.effort_env.as_deref().or_else(|| {
            self.sources.iter().rev().find_map(|source| {
                model
                    .and_then(|model| source.models.get(model))
                    .and_then(|settings| settings.effort.as_deref())
                    .or(source.effort.as_deref())
            })
        })?;
        matches!(value, "low" | "medium" | "high" | "xhigh" | "max").then(|| value.to_string())
    }

    fn context(&self) -> (Option<u64>, bool) {
        if let Some(value) = &self.context_env {
            return (
                value.trim().parse::<u64>().ok().filter(|value| *value > 0),
                false,
            );
        }
        match self
            .sources
            .iter()
            .rev()
            .find_map(|source| source.context.as_ref())
        {
            Some(value) => (
                value.as_u64().filter(|value| *value > 0),
                value.as_str() == Some("auto"),
            ),
            None => (None, true),
        }
    }
}

pub(super) async fn resolve_claude_defaults(
    workspace: &std::path::Path,
    env: &[(String, String)],
) -> Option<ClaudeDefaults> {
    let entry = crate::process::env::resolve_acp_agent_bin("claude-agent-acp").ok()?;
    let mut command = crate::process::env::command("node");
    command
        .current_dir(workspace)
        .envs(env.iter().cloned())
        .args([
            "--input-type=module",
            "-e",
            include_str!("claude_defaults.mjs"),
        ])
        .arg(entry)
        .kill_on_drop(true);
    let output = tokio::time::timeout(std::time::Duration::from_secs(5), command.output())
        .await
        .ok()?
        .ok()?;
    if !output.status.success() {
        return None;
    }
    serde_json::from_slice(&output.stdout).ok()
}

impl SessionMetadata {
    pub(super) fn set_local_defaults(&mut self, defaults: Option<ClaudeDefaults>) {
        if let Some(defaults) = &defaults {
            let (context, automatic) = defaults.context();
            self.context_window_default = context;
            self.context_window_automatic = automatic;
        }
        self.local_defaults = defaults;
    }

    fn configured_effort(&self, options: &[acp::SessionConfigOption]) -> Option<String> {
        self.local_defaults
            .as_ref()?
            .effort(selected_value(options, "model"))
    }

    /// Only a fresh session, before restoring chat overrides, advertises defaults.
    pub(super) fn set_fresh_config(&mut self, options: Vec<acp::SessionConfigOption>) {
        self.effort_default = self.configured_effort(&options).or_else(|| {
            selected_value(&options, "effort")
                .filter(|value| {
                    !value.trim().is_empty()
                        && !value.eq_ignore_ascii_case("default")
                        && !value.eq_ignore_ascii_case("auto")
                })
                .map(str::to_string)
        });
        self.config_options = options;
    }

    pub(super) fn update_config(&mut self, options: Vec<acp::SessionConfigOption>) {
        // A model change may carry an explicit effort override into its response.
        // Do not promote that current selection to the new model's default.
        if selected_value(&self.config_options, "model") != selected_value(&options, "model")
            || selected_value(&options, "effort").is_none()
        {
            self.effort_default =
                selected_value(&options, "effort").and_then(|_| self.configured_effort(&options));
        }
        self.config_options = options;
    }
}

fn selected_value<'a>(options: &'a [acp::SessionConfigOption], id: &str) -> Option<&'a str> {
    options.iter().find_map(|option| {
        let matches = option.id.0.as_ref() == id
            || (id == "model" && option.category == Some(acp::SessionConfigOptionCategory::Model))
            || (id == "effort"
                && option.category == Some(acp::SessionConfigOptionCategory::ThoughtLevel));
        match &option.kind {
            acp::SessionConfigKind::Select(select) if matches => {
                Some(select.current_value.0.as_ref())
            }
            _ => None,
        }
    })
}

pub(super) fn context_window_default(
    agent_id: &str,
    env: &[(String, String)],
    inherited: Option<&str>,
) -> Option<u64> {
    if agent_id != "claude" {
        return None;
    }
    // Match child process precedence, including an empty/invalid profile value
    // shadowing inheritance. Never infer a native model limit when none is set.
    env.iter()
        .rev()
        .find(|(key, _)| {
            if cfg!(windows) {
                key.eq_ignore_ascii_case("CLAUDE_CODE_AUTO_COMPACT_WINDOW")
            } else {
                key == "CLAUDE_CODE_AUTO_COMPACT_WINDOW"
            }
        })
        .map(|(_, value)| value.as_str())
        .or(inherited)
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|value| *value > 0)
}

pub(super) fn context_window_value(agent_id: &str, value: &str) -> acp::Result<Option<u64>> {
    if agent_id != "claude" {
        return Err(acp::Error::new(
            -32602,
            "Compaction budget is only supported by Claude.",
        ));
    }
    if value == "auto" {
        return Ok(None);
    }
    value
        .parse::<u64>()
        .ok()
        .filter(|value| CONTEXT_WINDOW_CHOICES.contains(value))
        .map(Some)
        .ok_or_else(|| {
            acp::Error::new(
                -32602,
                "Compaction budget must be auto, 100000, 200000, 500000 or 1000000.",
            )
        })
}

pub(super) fn validate_option(
    options: &[acp::SessionConfigOption],
    id: &str,
    value: &str,
) -> acp::Result<()> {
    let option = options
        .iter()
        .find(|option| option.id.0.as_ref() == id)
        .ok_or_else(|| {
            acp::Error::new(
                -32602,
                format!("Session config `{id}` is not advertised by this agent."),
            )
        })?;
    let acp::SessionConfigKind::Select(select) = &option.kind else {
        return Err(acp::Error::new(
            -32602,
            "Only advertised select options are supported.",
        ));
    };
    if select.current_value.0.as_ref() == value {
        return Ok(());
    }
    let matches = |option: &acp::SessionConfigSelectOption| option.value.0.as_ref() == value;
    let valid = match &select.options {
        acp::SessionConfigSelectOptions::Ungrouped(options) => options.iter().any(matches),
        acp::SessionConfigSelectOptions::Grouped(groups) => {
            groups.iter().any(|group| group.options.iter().any(matches))
        }
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err(acp::Error::new(
            -32602,
            format!("Value `{value}` is not advertised for session config `{id}`."),
        ))
    }
}

pub(super) fn require_idle(prompt_active: bool, subagent_active: bool) -> acp::Result<()> {
    if prompt_active || subagent_active {
        Err(acp::Error::new(
            -32603,
            "Session settings cannot change while a prompt or subagent is running.",
        ))
    } else {
        Ok(())
    }
}

pub(super) fn apply_context_env(
    env: &mut Vec<(String, String)>,
    agent_id: &str,
    budget: Option<u64>,
) {
    let Some(budget) = budget.filter(|_| agent_id == "claude") else {
        // No session override means preserve the profile and inherited CLI defaults.
        return;
    };
    env.retain(|(name, _)| name != "CLAUDE_CODE_AUTO_COMPACT_WINDOW");
    env.push((
        "CLAUDE_CODE_AUTO_COMPACT_WINDOW".to_string(),
        budget.to_string(),
    ));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options(model: &str, effort: &str) -> Vec<acp::SessionConfigOption> {
        serde_json::from_value(serde_json::json!([
            {"id":"model","name":"Model","type":"select","currentValue":model,"options":[]},
            {"id":"effort","name":"Effort","type":"select","currentValue":effort,"options":[]}
        ]))
        .unwrap()
    }

    #[test]
    fn sdk_model_settings_resolve_suffix_precedence_and_resumed_defaults() {
        let defaults: ClaudeDefaults = serde_json::from_value(serde_json::json!({
            "sources": [{"effort":"medium","models":{"gateway-model":{"effort":"high"}}}],
            "effort_env":null,"context_env":null
        }))
        .unwrap();
        let mut metadata = SessionMetadata::default();
        metadata.set_local_defaults(Some(defaults.clone()));
        metadata.set_fresh_config(options("gateway-model[1m]", "default"));
        assert_eq!(metadata.effort_default.as_deref(), Some("high"));
        assert!(metadata.context_window_automatic);
        metadata.update_config(options("other-model", "low"));
        assert_eq!(metadata.effort_default.as_deref(), Some("medium"));
        let mut resumed = SessionMetadata::default();
        resumed.set_local_defaults(Some(defaults.clone()));
        resumed.update_config(options("gateway-model[1m]", "low"));
        assert_eq!(resumed.effort_default.as_deref(), Some("high"));
        let mut higher_source = defaults.clone();
        higher_source.sources.push(ClaudeSettingsSource {
            effort: Some("low".into()),
            ..Default::default()
        });
        assert_eq!(
            higher_source.effort(Some("gateway-model[1m]")).as_deref(),
            Some("low")
        );
        higher_source.effort_env = Some("xhigh".into());
        assert_eq!(
            higher_source.effort(Some("gateway-model[1m]")).as_deref(),
            Some("xhigh")
        );
    }

    #[test]
    fn sdk_context_settings_distinguish_automatic_from_missing_resolution() {
        let mut metadata = SessionMetadata::default();
        metadata.set_local_defaults(None);
        assert!(!metadata.context_window_automatic);
        let mut defaults = ClaudeDefaults::default();
        metadata.set_local_defaults(Some(defaults.clone()));
        assert!(metadata.context_window_automatic);
        defaults.sources.push(ClaudeSettingsSource {
            context: Some(serde_json::json!(300000)),
            ..Default::default()
        });
        assert_eq!(defaults.context(), (Some(300000), false));
        defaults.context_env = Some("500000".into());
        assert_eq!(defaults.context(), (Some(500000), false));
        defaults.context_env = Some("invalid".into());
        assert_eq!(defaults.context(), (None, false));
    }

    #[test]
    fn defaults_are_captured_before_overrides_and_never_inferred_from_updates() {
        let mut metadata = SessionMetadata::default();
        metadata.set_fresh_config(options("model-a", "high"));
        assert_eq!(metadata.effort_default.as_deref(), Some("high"));
        metadata.update_config(options("model-a", "low"));
        assert_eq!(metadata.effort_default.as_deref(), Some("high"));
        metadata.update_config(options("model-a", "default"));
        assert_eq!(metadata.effort_default.as_deref(), Some("high"));
        assert_eq!(
            selected_value(&metadata.config_options, "effort"),
            Some("default")
        );
        metadata.update_config(options("model-b", "low"));
        assert_eq!(metadata.effort_default, None);
        metadata.update_config(options("model-b", "default"));
        assert_eq!(metadata.effort_default, None);
        metadata.set_fresh_config(options("model-b", "medium"));
        assert_eq!(metadata.effort_default.as_deref(), Some("medium"));
        metadata.update_config(Vec::new());
        assert_eq!(metadata.effort_default, None);
    }

    #[test]
    fn sentinel_missing_and_resumed_effort_defaults_stay_unknown() {
        for value in ["default", "auto", "", "Default"] {
            let mut metadata = SessionMetadata::default();
            metadata.set_fresh_config(options("model-a", value));
            assert_eq!(metadata.effort_default, None);
        }
        let mut metadata = SessionMetadata::default();
        // A loaded session may already contain a native explicit selection.
        metadata.update_config(options("model-a", "high"));
        assert_eq!(metadata.effort_default, None);
        metadata.set_fresh_config(Vec::new());
        assert_eq!(metadata.effort_default, None);
    }

    #[test]
    fn context_default_uses_launch_precedence_before_chat_override() {
        let mut env = vec![("CLAUDE_CODE_AUTO_COMPACT_WINDOW".into(), "180000".into())];
        let default = context_window_default("claude", &env, Some("200000"));
        assert_eq!(default, Some(180_000));
        apply_context_env(&mut env, "claude", Some(500_000));
        assert_eq!(default, Some(180_000));
        assert_eq!(env[0].1, "500000");
        assert_eq!(
            context_window_default("claude", &[], Some("240000")),
            Some(240_000)
        );
        assert_eq!(context_window_default("claude", &[], None), None);
        assert_eq!(context_window_default("codex", &env, Some("200000")), None);
        for value in ["", "0", "-1", "1m", "100000.5", "unknown"] {
            let env = vec![("CLAUDE_CODE_AUTO_COMPACT_WINDOW".into(), value.into())];
            assert_eq!(context_window_default("claude", &env, Some("200000")), None);
        }
        let env = vec![
            ("CLAUDE_CODE_AUTO_COMPACT_WINDOW".into(), "180000".into()),
            ("CLAUDE_CODE_AUTO_COMPACT_WINDOW".into(), "300000".into()),
        ];
        assert_eq!(context_window_default("claude", &env, None), Some(300_000));
    }

    #[test]
    fn validates_flat_and_grouped_advertised_values_without_model_assumptions() {
        for options in [
            serde_json::json!([{"value":"gateway/custom","name":"Custom"}]),
            serde_json::json!([{"group":"custom","name":"Gateway","options":[{"value":"gateway/custom","name":"Custom"}]}]),
        ] {
            let config: acp::SessionConfigOption = serde_json::from_value(serde_json::json!({
                "id":"model", "name":"Model", "type":"select", "currentValue":"gateway/custom", "options":options
            })).unwrap();
            assert!(validate_option(&[config.clone()], "model", "gateway/custom").is_ok());
            assert!(validate_option(&[config.clone()], "model", "made-up").is_err());
            assert!(validate_option(&[config], "effort", "high").is_err());
        }
    }

    #[test]
    fn validates_context_budget_and_busy_states() {
        assert_eq!(context_window_value("claude", "auto").unwrap(), None);
        for value in CONTEXT_WINDOW_CHOICES {
            assert_eq!(
                context_window_value("claude", &value.to_string()).unwrap(),
                Some(value)
            );
        }
        for value in ["0", "-1", "500", "1m", "100000.0", "2000000"] {
            assert!(context_window_value("claude", value).is_err());
        }
        assert!(context_window_value("codex", "200000").is_err());
        assert!(require_idle(false, false).is_ok());
        for busy in [(true, false), (false, true), (true, true)] {
            assert!(require_idle(busy.0, busy.1).is_err());
        }
    }

    #[test]
    fn context_environment_only_changes_the_child_override() {
        let inherited = std::env::var_os("CLAUDE_CODE_AUTO_COMPACT_WINDOW");
        let mut env = vec![("ANTHROPIC_MODEL".into(), "gateway/custom".into())];
        apply_context_env(&mut env, "claude", Some(500_000));
        assert_eq!(env[0].1, "gateway/custom");
        assert_eq!(env[1].1, "500000");
        apply_context_env(&mut env, "claude", None);
        assert_eq!(env.len(), 2);
        assert_eq!(env[1].1, "500000");
        let mut profile_env = vec![("CLAUDE_CODE_AUTO_COMPACT_WINDOW".into(), "180000".into())];
        apply_context_env(&mut profile_env, "claude", None);
        assert_eq!(profile_env[0].1, "180000");
        assert_eq!(
            std::env::var_os("CLAUDE_CODE_AUTO_COMPACT_WINDOW"),
            inherited
        );
    }
}
