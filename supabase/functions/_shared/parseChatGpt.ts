import type { ParsedConversation, ParsedMessage, ParseResult } from "./types.ts";

interface RawMessage {
  id?: string;
  author?: { role?: string };
  content?: unknown;
  create_time?: number | null;
  metadata?: { is_visually_hidden_from_conversation?: boolean };
}

interface RawNode {
  id?: string;
  parent?: string | null;
  message?: RawMessage | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!isRecord(content) || !Array.isArray(content.parts)) return "";
  return content.parts
    .filter((part): part is string => typeof part === "string")
    .join("\n")
    .trim();
}

function unixToIso(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return new Date(value * 1000).toISOString();
}

function activeNodes(mapping: Record<string, RawNode>, current: string): RawNode[] {
  const chain: RawNode[] = [];
  const seen = new Set<string>();
  let id: string | null = current;
  while (id && !seen.has(id)) {
    seen.add(id);
    const node = mapping[id];
    if (!node) break;
    chain.push(node);
    const parent = node.parent;
    id = typeof parent === "string" ? parent : null;
  }
  chain.reverse();
  return chain;
}

function keepRole(role: string | undefined): role is "user" | "assistant" {
  return role === "user" || role === "assistant";
}

function messageFromRaw(
  raw: RawMessage | null | undefined,
  conversationId: string,
  conversationTitle: string,
  ordinal: number,
): ParsedMessage | null {
  if (!raw) return null;
  if (raw.metadata?.is_visually_hidden_from_conversation === true) return null;
  const role = raw.author?.role;
  if (!keepRole(role)) return null;
  const text = textFromContent(raw.content);
  if (!text) return null;
  const messageId = typeof raw.id === "string" && raw.id.length > 0 ? raw.id : "";
  if (!messageId) return null;
  return {
    conversationId,
    conversationTitle,
    messageId,
    role,
    text,
    createdAt: unixToIso(raw.create_time),
    ordinal,
  };
}

function conversationIdOf(value: Record<string, unknown>, index: number): string {
  if (typeof value.id === "string" && value.id.length > 0) return value.id;
  if (typeof value.conversation_id === "string" && value.conversation_id.length > 0) {
    return value.conversation_id;
  }
  return `conv_${index + 1}`;
}

function titleOf(value: Record<string, unknown>): string {
  return typeof value.title === "string" ? value.title : "Untitled chat";
}

function parseLinear(value: Record<string, unknown>, index: number, warnings: string[]): ParsedConversation | null {
  if (!Array.isArray(value.messages)) return null;
  const id = conversationIdOf(value, index);
  const title = titleOf(value);
  const messages: ParsedMessage[] = [];
  for (const item of value.messages) {
    if (!isRecord(item)) continue;
    const parsed = messageFromRaw(item as RawMessage, id, title, messages.length);
    if (parsed) messages.push(parsed);
  }
  if (messages.length === 0) {
    warnings.push(`Conversation ${id} had a messages array but no visible user or assistant text.`);
  }
  return { id, title, messages };
}

function parseMapped(value: Record<string, unknown>, index: number, warnings: string[]): ParsedConversation | null {
  if (!isRecord(value.mapping)) return null;
  const id = conversationIdOf(value, index);
  const title = titleOf(value);
  const current = value.current_node;
  if (typeof current !== "string" || current.length === 0) {
    warnings.push(`Conversation ${id} has a mapping but no current_node, so its inactive branches were not guessed.`);
    return { id, title, messages: [] };
  }
  const mapping = value.mapping as Record<string, RawNode>;
  const messages: ParsedMessage[] = [];
  for (const node of activeNodes(mapping, current)) {
    const parsed = messageFromRaw(node.message, id, title, messages.length);
    if (parsed) messages.push(parsed);
  }
  return { id, title, messages };
}

function parseConversation(value: unknown, index: number, warnings: string[]): ParsedConversation | null {
  if (!isRecord(value)) {
    warnings.push(`Skipped item ${index + 1} because it was not an object.`);
    return null;
  }
  if (isRecord(value.mapping)) return parseMapped(value, index, warnings);
  if (Array.isArray(value.messages)) return parseLinear(value, index, warnings);
  warnings.push(`Conversation ${conversationIdOf(value, index)} has neither mapping nor messages.`);
  return null;
}

export function coerceConversations(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (isRecord(data) && Array.isArray(data.conversations)) return data.conversations;
  if (isRecord(data) && (isRecord(data.mapping) || Array.isArray(data.messages))) return [data];
  throw new Error(
    "Expected a ChatGPT conversations array, a { conversations } wrapper, or one conversation object.",
  );
}

export function parseChatGptExport(data: unknown): ParseResult {
  const warnings: string[] = [];
  const items = coerceConversations(data);
  const conversations: ParsedConversation[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const parsed = parseConversation(items[index], index, warnings);
    if (parsed) conversations.push(parsed);
  }
  return finish(conversations, warnings);
}

export function parseChatGptFiles(documents: unknown[]): ParseResult {
  const warnings: string[] = [];
  const conversations: ParsedConversation[] = [];
  const seen = new Set<string>();
  for (const document of documents) {
    let parsed: ParseResult;
    try {
      parsed = parseChatGptExport(document);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not read an export file.";
      warnings.push(message);
      continue;
    }
    warnings.push(...parsed.warnings);
    for (const conversation of parsed.conversations) {
      if (seen.has(conversation.id)) {
        warnings.push(`Skipped a repeated conversation id ${conversation.id}.`);
        continue;
      }
      seen.add(conversation.id);
      conversations.push(conversation);
    }
  }
  return finish(conversations, warnings);
}

function finish(conversations: ParsedConversation[], warnings: string[]): ParseResult {
  const messages: ParsedMessage[] = [];
  const renumbered = conversations.map((conversation) => {
    const nextMessages = conversation.messages.map((message) => {
      const ordinal = messages.length;
      const next = { ...message, ordinal };
      messages.push(next);
      return next;
    });
    return { ...conversation, messages: nextMessages };
  });
  return { conversations: renumbered, messages, warnings };
}
