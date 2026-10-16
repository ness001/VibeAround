use super::super::session_config::{
    apply_context_env, context_window_value, require_idle, validate_option,
    CONTEXT_WINDOW_CONFIG_ID,
};
use super::*;

impl ThreadRuntime {
    pub(crate) async fn prepare_config(
        self: &Arc<Self>,
        route: RouteKey,
        handler: Arc<dyn AgentClientHandler>,
    ) -> acp::Result<()> {
        let (reply, done) = oneshot::channel();
        self.owner_tx.send(ThreadOwnerCommand::PrepareConfig {
            runtime: Arc::clone(self), route, handler, reply,
        }).map_err(|_| runtime_stopped_error())?;
        done.await.unwrap_or_else(|_| Err(runtime_stopped_error()))
    }

    pub async fn set_config_option(
        self: &Arc<Self>,
        config_id: String,
        value: String,
    ) -> acp::Result<()> {
        let (reply, done) = oneshot::channel();
        self.owner_tx
            .send(ThreadOwnerCommand::SetConfig {
                runtime: Arc::clone(self),
                config_id,
                value,
                reply,
            })
            .map_err(|_| runtime_stopped_error())?;
        done.await.unwrap_or_else(|_| Err(runtime_stopped_error()))
    }

    pub async fn set_session_mode(self: &Arc<Self>, mode_id: String) -> acp::Result<()> {
        let (reply, done) = oneshot::channel();
        self.owner_tx
            .send(ThreadOwnerCommand::SetMode {
                runtime: Arc::clone(self),
                mode_id,
                reply,
            })
            .map_err(|_| runtime_stopped_error())?;
        done.await.unwrap_or_else(|_| Err(runtime_stopped_error()))
    }
}

impl ThreadOwner {
    pub(super) fn config_is_pristine(&self) -> bool {
        self.session_id.is_none()
            && self.host.is_none()
            && self.thread.agent_sessions.is_empty()
            && self.thread.first_user_prompt.is_none()
    }

    pub(super) fn check_config_idle(&self, prompt_active: bool) -> acp::Result<()> {
        if self.thread.status == ThreadStatus::Closed {
            return Err(acp::Error::new(-32603, "workspace thread is closed"));
        }
        let subagent_active = self
            .thread
            .agents
            .values()
            .any(|agent| agent.status == ThreadAgentStatus::Running)
            || self
                .subagents
                .values()
                .any(|agent| agent.active_turn_target.current().is_some());
        require_idle(prompt_active, subagent_active)
    }

    fn config_agent(&self) -> acp::Result<(Arc<Agent>, String)> {
        let host = self.host.as_ref().filter(|host| host.is_live())
            .ok_or_else(|| acp::Error::new(-32603, "Session settings require a running session. Send a message or resume it first."))?;
        let session_id = self
            .session_id
            .clone()
            .ok_or_else(|| acp::Error::new(-32603, "No agent session is ready."))?;
        Ok((Arc::clone(&host.agent), session_id))
    }

    pub(super) async fn change_config(
        &mut self,
        runtime: &ThreadRuntime,
        id: &str,
        value: &str,
        prompt_active: bool,
    ) -> acp::Result<()> {
        self.check_config_idle(prompt_active)?;
        let mut preferences = self.thread.session_preferences.clone();
        if id == CONTEXT_WINDOW_CONFIG_ID {
            let budget = context_window_value(&self.thread.host_binding.agent_id, value)?;
            if preferences.context_window == budget {
                return Ok(());
            }
            if !self.config_is_pristine() {
                return Err(acp::Error::new(-32602, "Choose the compaction budget before starting a session; start a new chat to change it."));
            }
            preferences.context_window = budget;
            self.persist_thread_event(
                runtime,
                &ThreadEvent::session_preferences_changed(self.thread.id.clone(), preferences),
            )
            .await?;
            return Ok(());
        }
        if self.config_is_pristine() {
            if !matches!(id, "model" | "effort") {
                return Err(acp::Error::new(-32602, "This setting can only change after the session starts."));
            }
            let previous_metadata = self.metadata.read().unwrap_or_else(|error| error.into_inner()).clone();
            validate_option(&previous_metadata.config_options, id, value)?;
            if previous_metadata.config_options.iter().any(|option| option.id.0.as_ref() == id
                && matches!(&option.kind, acp::SessionConfigKind::Select(select) if select.current_value.0.as_ref() == value)) {
                return Ok(());
            }
            let (route, handler) = self.prepare_context.clone().ok_or_else(|| acp::Error::new(-32603, "Prepare session controls before changing this setting."))?;
            let previous_preferences = self.thread.session_preferences.clone();
            preferences.config_options.insert(id.to_string(), value.to_string());
            if id == "model" {
                preferences.config_options.remove("effort");
            }
            // Probe the selected settings before persisting or acknowledging them.
            self.thread.session_preferences = preferences.clone();
            self.metadata.write().unwrap_or_else(|error| error.into_inner()).prepared = false;
            let result = self.prepare_controls(runtime, &route, handler).await.and_then(|()| {
                let metadata = self.metadata.read().unwrap_or_else(|error| error.into_inner());
                if metadata.config_options.iter().any(|option| option.id.0.as_ref() == id
                    && matches!(&option.kind, acp::SessionConfigKind::Select(select) if select.current_value.0.as_ref() == value)) {
                    Ok(())
                } else {
                    Err(acp::Error::new(-32603, "The agent did not confirm the selected setting; the previous value was kept."))
                }
            });
            self.thread.session_preferences = previous_preferences;
            if let Err(error) = result {
                self.metadata = Arc::new(RwLock::new(previous_metadata));
                self.publish_runtime_state();
                return Err(error);
            }
            if let Err(error) = self.persist_thread_event(runtime, &ThreadEvent::session_preferences_changed(self.thread.id.clone(), preferences)).await {
                self.metadata = Arc::new(RwLock::new(previous_metadata));
                self.publish_runtime_state();
                return Err(error);
            }
            return Ok(());
        }
        let (agent, session_id) = self.config_agent()?;
        self.apply_config(&agent, &session_id, id, value).await?;
        preferences
            .config_options
            .insert(id.to_string(), value.to_string());
        {
            let metadata = self
                .metadata
                .read()
                .unwrap_or_else(|error| error.into_inner());
            // Model changes may remove effort or change its valid values. Persist
            // only agent-confirmed current values, never the previous model's list.
            preferences.config_options.retain(|id, value| {
                if let Some(acp::SessionConfigKind::Select(select)) = metadata
                    .config_options
                    .iter()
                    .find(|option| option.id.0.as_ref() == id.as_str())
                    .map(|option| &option.kind)
                {
                    *value = select.current_value.to_string();
                    true
                } else {
                    false
                }
            });
        }
        self.persist_thread_event(
            runtime,
            &ThreadEvent::session_preferences_changed(self.thread.id.clone(), preferences),
        )
        .await
    }

    pub(super) async fn apply_config(
        &mut self,
        agent: &Agent,
        session_id: &str,
        id: &str,
        value: &str,
    ) -> acp::Result<()> {
        {
            let metadata = self
                .metadata
                .read()
                .unwrap_or_else(|error| error.into_inner());
            validate_option(&metadata.config_options, id, value)?;
        }
        let response = tokio::time::timeout(
            Duration::from_secs(30),
            agent.set_session_config_option(acp::SetSessionConfigOptionRequest::new(
                session_id.to_string(), id.to_string(), value,
            )),
        ).await.map_err(|_| acp::Error::new(-32603, "Agent settings request timed out; refresh the session state before retrying."))?
            .map_err(|error| {
                if let Some(data) = &error.data {
                    let detail = data.as_str()
                        .or_else(|| data.get("message").and_then(serde_json::Value::as_str))
                        .or_else(|| data.get("details").and_then(serde_json::Value::as_str));
                    if detail.is_some_and(|detail| detail.contains("max_output_tokens") && detail.contains("minimum")) {
                        return acp::Error::new(-32603, "The model provider rejected Claude's model-validation request: its minimum output-token limit is incompatible. The current model was kept; the gateway needs a compatibility update.");
                    }
                }
                error
            })?;
        let confirmed = response.config_options.iter().any(|option| {
            option.id.0.as_ref() == id && matches!(&option.kind, acp::SessionConfigKind::Select(select) if select.current_value.0.as_ref() == value)
        });
        self.metadata
            .write()
            .unwrap_or_else(|error| error.into_inner())
            .update_config(response.config_options);
        self.publish_runtime_state();
        if !confirmed {
            return Err(acp::Error::new(
                -32603,
                format!("Agent did not confirm session config `{id}` = `{value}`."),
            ));
        }
        Ok(())
    }

    pub(super) async fn change_mode(
        &mut self,
        runtime: &ThreadRuntime,
        mode_id: &str,
        prompt_active: bool,
    ) -> acp::Result<()> {
        self.check_config_idle(prompt_active)?;
        let config_id = {
            let metadata = self
                .metadata
                .read()
                .unwrap_or_else(|error| error.into_inner());
            metadata
                .config_options
                .iter()
                .find(|option| {
                    option.id.0.as_ref() == "mode"
                        || option.category == Some(acp::SessionConfigOptionCategory::Mode)
                })
                .map(|option| option.id.to_string())
        };
        if let Some(config_id) = config_id {
            return self
                .change_config(runtime, &config_id, mode_id, prompt_active)
                .await;
        }
        let (agent, session_id) = self.config_agent()?;
        let advertised = self
            .metadata
            .read()
            .unwrap_or_else(|error| error.into_inner())
            .modes
            .as_ref()
            .is_some_and(|modes| {
                modes
                    .available_modes
                    .iter()
                    .any(|mode| mode.id.0.as_ref() == mode_id)
            });
        if !advertised {
            return Err(acp::Error::new(
                -32602,
                format!("Session mode `{mode_id}` is not advertised by this agent."),
            ));
        }
        tokio::time::timeout(
            Duration::from_secs(30),
            agent.set_session_mode(acp::SetSessionModeRequest::new(
                session_id,
                mode_id.to_string(),
            )),
        )
        .await
        .map_err(|_| acp::Error::new(-32603, "Agent mode request timed out."))??;
        if let Some(modes) = self
            .metadata
            .write()
            .unwrap_or_else(|error| error.into_inner())
            .modes
            .as_mut()
        {
            modes.current_mode_id = mode_id.to_string().into();
        }
        self.publish_runtime_state();
        Ok(())
    }

    pub(super) async fn restore_config(
        &mut self,
        agent: &Agent,
        session_id: &str,
    ) -> acp::Result<()> {
        let mut preferences: Vec<_> = self
            .thread
            .session_preferences
            .config_options
            .clone()
            .into_iter()
            .collect();
        // Model selection can change the advertised effort choices.
        preferences.sort_by_key(|(id, _)| if id == "model" { 0 } else { 1 });
        for (id, value) in preferences {
            let already_selected = self.metadata.read().unwrap_or_else(|error| error.into_inner()).config_options.iter()
                .any(|option| option.id.0.as_ref() == id.as_str() && matches!(&option.kind, acp::SessionConfigKind::Select(select) if select.current_value.0.as_ref() == value.as_str()));
            if !already_selected {
                if let Err(error) = self.apply_config(agent, session_id, &id, &value).await {
                    // An adapter/model update may retire an option. Keep the session
                    // usable so the owner can select a currently advertised value.
                    tracing::warn!(config_id = %id, error = %error.message, "Saved session setting could not be restored; retaining agent default");
                }
            }
        }
        Ok(())
    }

    pub(super) fn context_env(&self, env: &mut Vec<(String, String)>, agent_id: &str) {
        apply_context_env(
            env,
            agent_id,
            self.thread.session_preferences.context_window,
        );
        if agent_id == "claude" && self.session_id.is_none() && self.thread.agent_sessions.is_empty() {
            if let Some(model) = self.thread.session_preferences.config_options.get("model") {
                env.retain(|(key, _)| key != "ANTHROPIC_MODEL");
                env.push(("ANTHROPIC_MODEL".to_string(), model.clone()));
            }
        }
    }
}

pub(super) struct ProbeHandler {
    pub(super) inner: Arc<dyn AgentClientHandler>,
}

#[async_trait::async_trait]
impl AgentClientHandler for ProbeHandler {
    async fn session_notification(&self, _args: acp::SessionNotification) -> acp::Result<()> {
        Ok(())
    }

    async fn request_permission(&self, _args: acp::RequestPermissionRequest) -> acp::Result<acp::RequestPermissionResponse> {
        Ok(acp::RequestPermissionResponse::new(acp::RequestPermissionOutcome::Cancelled))
    }

    fn mcp_server(&self) -> Option<Arc<dyn crate::agent::AcpMcpServer>> {
        self.inner.mcp_server()
    }
}

pub(super) struct ConfigTrackingHandler {
    pub(super) inner: Arc<dyn AgentClientHandler>,
    pub(super) metadata: Arc<RwLock<SessionMetadata>>,
}

#[async_trait::async_trait]
impl AgentClientHandler for ConfigTrackingHandler {
    async fn session_notification(&self, args: acp::SessionNotification) -> acp::Result<()> {
        {
            let mut metadata = self
                .metadata
                .write()
                .unwrap_or_else(|error| error.into_inner());
            match &args.update {
                acp::SessionUpdate::ConfigOptionUpdate(update) => {
                    metadata.update_config(update.config_options.clone())
                }
                acp::SessionUpdate::CurrentModeUpdate(update) => {
                    if let Some(modes) = metadata.modes.as_mut() {
                        modes.current_mode_id = update.current_mode_id.clone();
                    }
                }
                _ => {}
            }
        }
        self.inner.session_notification(args).await
    }
    async fn request_permission(
        &self,
        args: acp::RequestPermissionRequest,
    ) -> acp::Result<acp::RequestPermissionResponse> {
        self.inner.request_permission(args).await
    }
    async fn prompt_finished(&self, success: bool) -> acp::Result<()> {
        self.inner.prompt_finished(success).await
    }
    fn mcp_server(&self) -> Option<Arc<dyn crate::agent::AcpMcpServer>> {
        self.inner.mcp_server()
    }
}
