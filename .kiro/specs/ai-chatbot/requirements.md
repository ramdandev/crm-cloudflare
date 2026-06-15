# Requirements Document

## Introduction

This document specifies requirements for an AI Chatbot feature integrated into the Omnichannel SaaS CRM platform. The chatbot uses OpenAI-compatible APIs (supporting any provider such as OpenAI, OpenRouter, Groq, Together AI, or local LLMs) and is configurable per tenant. The chatbot auto-replies to incoming WhatsApp messages via the existing Go-Wa channel, maintains conversation context per contact, and tracks token usage per tenant for billing purposes.

## Glossary

- **Chatbot_Service**: The backend service responsible for generating AI-powered replies by calling an OpenAI-compatible API endpoint on behalf of a tenant.
- **Chatbot_Configuration**: The per-tenant settings record that defines the AI provider endpoint, API key, model selection, system prompt, behavior rules, and enabled state.
- **Conversation_Context**: The ordered history of messages between the chatbot and a specific contact within a tenant, used to provide contextual AI replies.
- **Token_Usage_Record**: A record tracking the number of prompt tokens and completion tokens consumed per AI request, associated with a tenant and contact.
- **OpenAI_Compatible_API**: Any HTTP API that conforms to the OpenAI Chat Completions request/response format (POST to /v1/chat/completions with messages array).
- **System_Prompt**: A tenant-defined instruction message sent as the first message in the conversation context to define the chatbot persona and behavior rules.
- **Auto_Reply_Trigger**: A rule that determines whether the chatbot should respond to an incoming message, based on conditions such as enabled state, working hours, and keyword matching.
- **Tenant**: An organization account in the CRM platform, identified by a unique tenant_id derived from a Clerk Organization ID.
- **Contact**: An individual person record within a tenant, identified by phone number or email.
- **Go_Wa_Channel**: The WhatsApp messaging channel powered by the Go-Wa (aldinokemal) gateway used for operational messaging.

## Requirements

### Requirement 1: Chatbot Configuration Management

**User Story:** As a tenant administrator, I want to configure my AI chatbot settings, so that I can control which AI provider, model, and persona the chatbot uses for my organization.

#### Acceptance Criteria

1. THE Chatbot_Service SHALL store Chatbot_Configuration records scoped to a tenant_id.
2. WHEN a tenant administrator creates a Chatbot_Configuration, THE Chatbot_Service SHALL require a non-empty base_url (valid HTTPS URL, maximum 2048 characters), a non-empty api_key (maximum 512 characters), and a non-empty model_name (maximum 128 characters, alphanumeric with hyphens, dots, slashes, and colons allowed).
3. WHEN a tenant administrator updates a Chatbot_Configuration, THE Chatbot_Service SHALL persist the changes and apply the updated configuration starting from the next chatbot request received after the update operation completes successfully.
4. THE Chatbot_Configuration SHALL support the following fields: base_url (API endpoint), api_key (encrypted at rest), model_name, system_prompt (text, maximum 10,000 characters), enabled (boolean), max_context_messages (integer, minimum 1, maximum 50), and max_tokens_per_reply (integer, minimum 1, maximum 16,384).
5. WHILE a Chatbot_Configuration has enabled set to false, THE Chatbot_Service SHALL not generate replies for that tenant.
6. IF a tenant administrator provides a base_url that is not a valid HTTPS URL or exceeds 2048 characters, THEN THE Chatbot_Service SHALL reject the configuration with a validation error indicating the base_url format requirement.
7. THE Chatbot_Service SHALL allow only one active Chatbot_Configuration per tenant at any time.
8. IF a tenant administrator provides a max_context_messages or max_tokens_per_reply value outside its permitted range, THEN THE Chatbot_Service SHALL reject the configuration with a validation error indicating the accepted range for the invalid field.
9. IF a tenant administrator provides a system_prompt exceeding 10,000 characters, THEN THE Chatbot_Service SHALL reject the configuration with a validation error indicating the maximum permitted length.

### Requirement 2: Auto-Reply Trigger Rules

**User Story:** As a tenant administrator, I want to configure when the chatbot automatically replies, so that the bot only responds during appropriate times and conditions.

#### Acceptance Criteria

1. THE Chatbot_Configuration SHALL include an auto_reply_rules field containing the following trigger condition fields: working_hours_only (boolean), start_hour (integer 0-23), end_hour (integer 0-23), keyword_triggers (list of strings, maximum 50 entries, each keyword maximum 100 characters), and reply_delay_ms (integer).
2. WHEN auto_reply_rules specifies working_hours_only as true, THE Chatbot_Service SHALL generate replies only during the tenant-configured working hours, where working hours are defined as the period from start_hour (inclusive) to end_hour (exclusive) in the tenant's configured timezone; IF start_hour is greater than end_hour, THEN the working period SHALL be interpreted as spanning midnight (e.g., start_hour 22 to end_hour 6 means 22:00–05:59).
3. WHEN auto_reply_rules specifies keyword_triggers as a non-empty list, THE Chatbot_Service SHALL generate replies only when the incoming message contains at least one keyword from the list, matched as a case-insensitive substring of the message text.
4. WHEN auto_reply_rules specifies keyword_triggers as an empty list or null, THE Chatbot_Service SHALL generate replies for all incoming messages (subject to other trigger conditions).
5. WHEN multiple trigger conditions are configured (working_hours_only and keyword_triggers), THE Chatbot_Service SHALL evaluate all active conditions using AND logic, generating a reply only when every active condition is satisfied.
6. WHILE the current time is outside the configured working hours and working_hours_only is true, THE Chatbot_Service SHALL not generate a reply to incoming messages.
7. THE Chatbot_Configuration SHALL include a timezone field (IANA timezone string) used for working hours evaluation.
8. IF a tenant administrator provides an invalid IANA timezone string in the timezone field, THEN THE Chatbot_Service SHALL reject the configuration update with a validation error indicating the timezone is not recognized.
9. WHEN auto_reply_rules specifies a reply_delay_ms value between 0 and 30000 (inclusive), THE Chatbot_Service SHALL wait the specified duration in milliseconds before sending the generated reply.
10. IF auto_reply_rules specifies a reply_delay_ms value less than 0 or greater than 30000, THEN THE Chatbot_Service SHALL reject the configuration update with a validation error indicating the delay must be between 0 and 30000 milliseconds.

### Requirement 3: AI Reply Generation

**User Story:** As a contact messaging a tenant's WhatsApp, I want to receive contextual AI-generated replies, so that I can get immediate assistance without waiting for a human agent.

#### Acceptance Criteria

1. WHEN an incoming WhatsApp text message is received via the Go_Wa_Channel and the tenant has an enabled Chatbot_Configuration, THE Chatbot_Service SHALL construct a Chat Completions request using the tenant's configured base_url, api_key, and model_name.
2. WHEN constructing the Chat Completions request, THE Chatbot_Service SHALL include the tenant's system_prompt as the first message (role: system) in the messages array sent to the OpenAI_Compatible_API.
3. WHEN constructing the Chat Completions request, THE Chatbot_Service SHALL include the most recent Conversation_Context messages (up to max_context_messages, minimum 1, maximum 50) in chronological order in the messages array, appended after the system message.
4. WHEN the OpenAI_Compatible_API returns a successful response (HTTP 200) with non-empty assistant reply content, THE Chatbot_Service SHALL extract the assistant reply content and send it as a text message to the contact via the Go_Wa_Channel.
5. IF the OpenAI_Compatible_API returns an error response (HTTP 4xx or 5xx), THEN THE Chatbot_Service SHALL log the error with tenant_id, contact_id, and error details, and shall not send a reply to the contact.
6. IF the OpenAI_Compatible_API does not respond within 30 seconds, THEN THE Chatbot_Service SHALL abort the request, log a timeout event with tenant_id and contact_id, and shall not send a reply to the contact.
7. WHEN constructing the Chat Completions request, THE Chatbot_Service SHALL set the max_tokens parameter to the max_tokens_per_reply value from the Chatbot_Configuration.
8. IF the OpenAI_Compatible_API returns a successful response (HTTP 200) but the assistant reply content is empty or null, THEN THE Chatbot_Service SHALL log a warning with tenant_id and contact_id, and shall not send a reply to the contact.
9. WHEN an incoming WhatsApp message of type image, video, audio, or document is received and the tenant has an enabled Chatbot_Configuration, THE Chatbot_Service SHALL not generate a reply for that message.
10. IF the system_prompt in the Chatbot_Configuration is empty or null, THEN THE Chatbot_Service SHALL omit the system message from the messages array and proceed with only the Conversation_Context messages.

### Requirement 4: Conversation Context Management

**User Story:** As a tenant, I want the chatbot to maintain conversation history per contact, so that replies are contextually relevant and coherent across multiple interactions.

#### Acceptance Criteria

1. THE Chatbot_Service SHALL store each incoming message and each generated reply as entries in the Conversation_Context for the corresponding tenant and contact pair, with the content field limited to a maximum of 4096 characters (truncating any excess from the end).
2. WHEN constructing the messages array for an AI request, THE Chatbot_Service SHALL retrieve the most recent non-archived messages up to the configured max_context_messages limit (counting only role "user" and "assistant" entries, excluding the system_prompt), ordered chronologically from oldest to newest.
3. THE Chatbot_Service SHALL store conversation context entries with the following fields: tenant_id, contact_id, role (user or assistant), content, created_at timestamp, and archived (boolean, default false).
4. WHEN max_context_messages is exceeded, THE Chatbot_Service SHALL include only the most recent messages within the limit, discarding older messages from the API request context.
5. THE Chatbot_Service SHALL not delete conversation context entries when they exceed max_context_messages; entries SHALL be retained indefinitely while the tenant remains active.
6. WHEN a tenant administrator resets the conversation context for a contact, THE Chatbot_Service SHALL set the archived field to true on all existing non-archived entries for that tenant and contact pair, so that subsequent AI requests retrieve only entries created after the reset.
7. IF an incoming message cannot be associated with a resolved contact_id (unlinked message), THEN THE Chatbot_Service SHALL not store a Conversation_Context entry and SHALL not generate an AI reply for that message.
8. THE Chatbot_Configuration SHALL enforce max_context_messages within the range of 1 to 100, with a default value of 20 if not explicitly set by the tenant administrator.

### Requirement 5: Token Usage Tracking

**User Story:** As a platform operator, I want to track AI token consumption per tenant, so that I can implement usage-based billing and enforce quotas.

#### Acceptance Criteria

1. WHEN the OpenAI_Compatible_API returns a successful response containing usage data (prompt_tokens and completion_tokens), THE Chatbot_Service SHALL create a Token_Usage_Record associated with the tenant_id and contact_id.
2. IF the OpenAI_Compatible_API returns a successful response that does not contain usage data (missing or null prompt_tokens or completion_tokens), THEN THE Chatbot_Service SHALL still deliver the reply to the contact but SHALL NOT create a Token_Usage_Record, and SHALL log a warning event including the tenant_id, contact_id, and model_name.
3. THE Token_Usage_Record SHALL include: tenant_id, contact_id, model_name, prompt_tokens (non-negative integer), completion_tokens (non-negative integer), total_tokens (non-negative integer), and created_at timestamp in ISO 8601 UTC format.
4. THE Chatbot_Service SHALL calculate total_tokens as the sum of prompt_tokens and completion_tokens for each Token_Usage_Record.
5. THE Chatbot_Service SHALL provide an API endpoint to query aggregated token usage per tenant, filterable by start_date and end_date (inclusive, ISO 8601 date format), returning the sum of total_tokens, sum of prompt_tokens, sum of completion_tokens, and count of requests within the specified date range.
6. WHEN a tenant has a configured monthly_token_limit (a positive integer) in the Chatbot_Configuration, THE Chatbot_Service SHALL check the sum of total_tokens for that tenant in the current calendar month (defined as day 1 00:00:00 UTC through the last day 23:59:59 UTC of the current month) before generating a reply.
7. IF the tenant's accumulated total_tokens for the current calendar month (UTC) equals or exceeds the monthly_token_limit, THEN THE Chatbot_Service SHALL not generate a reply, SHALL not call the OpenAI_Compatible_API, and SHALL log a quota_exceeded event including tenant_id, contact_id, the current accumulated total_tokens, and the configured monthly_token_limit.
8. IF the Chatbot_Configuration does not have a monthly_token_limit configured (null or absent), THEN THE Chatbot_Service SHALL generate replies without performing a quota check.

### Requirement 6: Integration with Go-Wa Incoming Message Webhook

**User Story:** As a platform developer, I want the AI chatbot to hook into the existing Go-Wa webhook flow, so that incoming messages trigger chatbot processing without duplicating webhook infrastructure.

#### Acceptance Criteria

1. WHEN the Go_Wa_Channel webhook receives an incoming message and the resolved tenant has a Chatbot_Configuration record with its enabled field set to true, THE Chatbot_Service SHALL be invoked to process the message using the received message content, resolved tenant_id, and sender phone number.
2. IF the resolved tenant does not have a Chatbot_Configuration record or the record has enabled set to false, THEN THE webhook handler SHALL skip chatbot invocation and complete normally without error.
3. THE Chatbot_Service SHALL execute asynchronously after the webhook returns its 200 response using the Cloudflare Workers waitUntil mechanism, so that chatbot processing does not block or delay webhook acknowledgment.
4. IF the Chatbot_Service encounters an error during asynchronous processing, THEN THE original webhook 200 response SHALL remain unaffected and the system SHALL log an entry to admin_alerts with type indicating chatbot processing failure, including the tenant_id and message_id.
5. THE Chatbot_Service SHALL use the same tenant_id and contact resolution logic as the existing Go_Wa_Channel webhook handler (resolved from the X-Tenant-Id header and contact lookup by phone number).
6. WHEN the chatbot generates a reply, THE Chatbot_Service SHALL send the reply using the existing GoWaService.sendMessage method with message_type set to text and channel set to gowa, with the reply content limited to 4096 characters.
7. IF the Chatbot_Service does not produce a reply within 30 seconds, THEN THE Chatbot_Service SHALL abort processing and log a timeout entry to admin_alerts with type indicating chatbot timeout, including the tenant_id and message_id.

### Requirement 7: API Key Security

**User Story:** As a tenant administrator, I want my AI provider API key to be stored securely, so that it cannot be exposed through API responses or logs.

#### Acceptance Criteria

1. THE Chatbot_Service SHALL encrypt the api_key field using AES-256-GCM with a platform encryption key sourced from the environment before persisting the Chatbot_Configuration to the database.
2. WHEN a tenant administrator retrieves the Chatbot_Configuration via the API, THE Chatbot_Service SHALL return the api_key in a masked format displaying a fixed prefix followed by the last 4 characters of the original key (e.g., "sk-...abc1234"), and SHALL NOT return any other portion of the plaintext key.
3. THE Chatbot_Service SHALL decrypt the api_key only within the scope of constructing and sending a single outbound request to the OpenAI_Compatible_API, and SHALL NOT cache or persist the decrypted value beyond that request.
4. THE Chatbot_Service SHALL NOT include the api_key value (whether plaintext, encrypted, or partially masked beyond the last 4 characters) in any log output, error messages, or exception details.
5. IF a tenant administrator updates the Chatbot_Configuration with the api_key field omitted or set to an empty string, THEN THE Chatbot_Service SHALL retain the existing encrypted api_key unchanged.
6. IF the Chatbot_Service fails to decrypt a stored api_key (due to corrupted data or unavailable platform encryption key), THEN THE Chatbot_Service SHALL NOT send a request to the OpenAI_Compatible_API, SHALL NOT generate a reply, and SHALL log a decryption failure event containing the tenant_id without including any key material.
