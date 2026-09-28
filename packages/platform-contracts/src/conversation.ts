import { z } from 'zod';

/**
 * Conversation storage contract.
 *
 * Shape follows the OpenUI `ThreadStorage` REST conventions so the ready-made
 * `restStorage()` factory can talk to this backend without an adapter:
 *   GET    {base}/get            → list
 *   POST   {base}/create         → create from first message
 *   GET    {base}/get/:id        → messages
 *   PATCH  {base}/update/:id     → rename / patch
 *   DELETE {base}/delete/:id     → delete
 */
export const conversationSchema = z.object({
  id: z.string(),
  title: z.string(),
  ownerId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /**
   * Claude Agent SDK session this conversation resumes. Owned by the backend,
   * set the first time a run reports its session id, never sent by the client.
   */
  claudeSessionId: z.string().nullable(),
  /** Canvas space the conversation is bound to. */
  spaceId: z.string().nullable(),
});
export type Conversation = z.infer<typeof conversationSchema>;

export const messageRoleSchema = z.enum(['user', 'assistant', 'system', 'tool']);
export type MessageRole = z.infer<typeof messageRoleSchema>;

export const storedMessageSchema = z.object({
  id: z.string(),
  role: messageRoleSchema,
  content: z.string(),
  createdAt: z.string(),
  /** Free-form presentation payload (tool activity, artifact refs). */
  meta: z.record(z.string(), z.unknown()).nullable().optional(),
});
export type StoredMessage = z.infer<typeof storedMessageSchema>;

/**
 * Capability disclosure for the chat surface. The UI reads this to avoid
 * offering features the backend does not implement.
 */
export interface ChatCapabilities {
  editMessage: boolean;
  branchConversation: boolean;
  restoreDeletedConversation: boolean;
  renameConversation: boolean;
  autoTitle: boolean;
  cancelRun: boolean;
}

export const CHAT_CAPABILITIES: ChatCapabilities = {
  editMessage: false,
  branchConversation: false,
  restoreDeletedConversation: false,
  renameConversation: true,
  autoTitle: true,
  cancelRun: true,
};
