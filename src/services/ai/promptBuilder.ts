/**
 * Prompt Builder Service.
 * Assembles the messages array for AI chat completions from conversation context,
 * knowledge base entries, contact history, and pipeline/lead data.
 *
 * Requirements: 3.1, 3.2, 3.4, 10.3, 10.4, 10.5
 */

import type { AIAgentConfig, ChatCompletionMessage } from '../../types/ai';

// ============================================================================
// Types
// ============================================================================

export interface PromptBuildInput {
  config: AIAgentConfig;
  recentMessages: Array<{ role: 'user' | 'assistant'; content: string }>;
  conversationSummary: string | null;
  kbEntries: Array<{ title: string; content: string; category: string }>;
  contactHistory: {
    purchases: Array<{ product: string; date: string; amount: number }>;
    appointments: Array<{ date: string; status: string }>;
    tickets: Array<{ type: string; status: string; description: string }>;
  };
  pipelineStage: string | null;
  leadScore: string | null;
  currentMessage: string;
}

// ============================================================================
// Prompt Builder
// ============================================================================

/**
 * Builds the complete messages array for an AI chat completion request.
 *
 * Assembly order:
 * 1. System message — tenant's system_prompt + injected context
 *    (conversation summary, contact history, KB entries, pipeline stage, lead score)
 * 2. Recent messages — from oldest to newest (role: user/assistant)
 * 3. Current message — the latest incoming message (role: user)
 *
 * @param input - All context needed to build the prompt
 * @returns Array of ChatCompletionMessage in correct order
 */
export function buildPrompt(input: PromptBuildInput): ChatCompletionMessage[] {
  const {
    config,
    recentMessages,
    conversationSummary,
    kbEntries,
    contactHistory,
    pipelineStage,
    leadScore,
    currentMessage,
  } = input;

  const messages: ChatCompletionMessage[] = [];

  // 1. System message: base system prompt + injected context
  const systemContent = buildSystemMessage(
    config.system_prompt,
    conversationSummary,
    contactHistory,
    kbEntries,
    pipelineStage,
    leadScore
  );

  messages.push({
    role: 'system',
    content: systemContent,
  });

  // 2. Recent messages (oldest to newest)
  for (const msg of recentMessages) {
    messages.push({
      role: msg.role,
      content: msg.content,
    });
  }

  // 3. Current message
  messages.push({
    role: 'user',
    content: currentMessage,
  });

  return messages;
}

/**
 * Builds the system message content by combining the tenant's system prompt
 * with injected context sections.
 */
function buildSystemMessage(
  systemPrompt: string,
  conversationSummary: string | null,
  contactHistory: PromptBuildInput['contactHistory'],
  kbEntries: Array<{ title: string; content: string; category: string }>,
  pipelineStage: string | null,
  leadScore: string | null
): string {
  const parts: string[] = [systemPrompt];

  // Append conversation summary if available
  if (conversationSummary) {
    parts.push(`Previous conversation summary: ${conversationSummary}`);
  }

  // Append contact history if there are entries
  const formattedHistory = formatContactHistory(contactHistory);
  if (formattedHistory) {
    parts.push(`Customer history: ${formattedHistory}`);
  }

  // Append relevant KB entries if found
  if (kbEntries.length > 0) {
    const formattedKB = formatKBEntries(kbEntries);
    parts.push(`Relevant knowledge: ${formattedKB}`);
  }

  // Append pipeline stage if available
  if (pipelineStage) {
    parts.push(`Current sales stage: ${pipelineStage}`);
  }

  // Append lead score if available
  if (leadScore) {
    parts.push(`Lead temperature: ${leadScore}`);
  }

  return parts.join('\n\n');
}

/**
 * Formats contact history into a human-readable string.
 * Returns null if there are no history entries.
 */
function formatContactHistory(
  contactHistory: PromptBuildInput['contactHistory']
): string | null {
  const sections: string[] = [];

  if (contactHistory.purchases.length > 0) {
    const purchaseLines = contactHistory.purchases.map(
      (p) => `- ${p.product} (${p.date}, ${p.amount})`
    );
    sections.push(`Purchases:\n${purchaseLines.join('\n')}`);
  }

  if (contactHistory.appointments.length > 0) {
    const appointmentLines = contactHistory.appointments.map(
      (a) => `- ${a.date}: ${a.status}`
    );
    sections.push(`Appointments:\n${appointmentLines.join('\n')}`);
  }

  if (contactHistory.tickets.length > 0) {
    const ticketLines = contactHistory.tickets.map(
      (t) => `- [${t.type}] ${t.description} (${t.status})`
    );
    sections.push(`Support tickets:\n${ticketLines.join('\n')}`);
  }

  if (sections.length === 0) {
    return null;
  }

  return sections.join('\n');
}

/**
 * Formats knowledge base entries into a readable block for the system prompt.
 */
function formatKBEntries(
  entries: Array<{ title: string; content: string; category: string }>
): string {
  return entries
    .map((entry) => `[${entry.category}] ${entry.title}: ${entry.content}`)
    .join('\n');
}

// ============================================================================
// Token Estimation
// ============================================================================

/**
 * Estimates the token count for a messages array.
 * Uses the approximation of 1 token ≈ 4 characters.
 * This is a rough estimate suitable for budget checking before making API calls.
 *
 * @param messages - Array of chat completion messages
 * @returns Estimated token count
 */
export function estimateTokens(messages: ChatCompletionMessage[]): number {
  let totalChars = 0;

  for (const message of messages) {
    // Count role overhead (~4 tokens for role + formatting)
    totalChars += message.role.length;
    // Count content
    totalChars += message.content.length;
  }

  return Math.ceil(totalChars / 4);
}
