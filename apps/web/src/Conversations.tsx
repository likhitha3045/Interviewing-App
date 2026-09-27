import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { io } from 'socket.io-client';
import { ArrowRight, MessageCircle, Paperclip, Plus, Search, Send, Users, X } from 'lucide-react';

const API = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';
type Person = { id: string; name: string; email: string; lastSeenAt?: string };
type Message = { id: string; conversationId: string; senderId: string; senderName: string; text: string; createdAt: string; editedAt?: string; deleted?: boolean; readAt?: string; replyTo?: { id: string; senderName: string; text: string }; attachment?: { name: string; mimeType: string; size: number; url: string }; reactions?: Array<{ userId: string; emoji: string }> };
type Conversation = { id: string; kind: 'direct' | 'group'; name: string; participants: Person[]; lastMessage?: Message | null; unreadCount: number };
type User = { id: string; name: string; email: string };

async function request<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API}${path}`, { ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...init.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message ?? 'Request failed.');
  return body as T;
}

export function ConversationsPage({ token, user }: { token: string; user: User }) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [active, setActive] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [typing, setTyping] = useState('');
  const [error, setError] = useState('');
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [participantEmails, setParticipantEmails] = useState('');
  const [groupName, setGroupName] = useState('');
  const [reply, setReply] = useState<Message | null>(null);
  const [edit, setEdit] = useState<Message | null>(null);
  const [presence, setPresence] = useState<Record<string, { online: boolean; lastSeenAt?: string }>>({});
  const uploadRef = useRef<HTMLInputElement>(null);
  const socketRef = useRef<ReturnType<typeof io> | null>(null);
  const messagesEnd = useRef<HTMLDivElement>(null);
  const otherName = (conversation: Conversation) => conversation.kind === 'group' ? conversation.name || 'Group chat' : conversation.participants.find((person) => person.id !== user.id)?.name ?? 'Direct conversation';

  useEffect(() => { void request<Conversation[]>('/api/conversations', token).then(setConversations).catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load chats.')); }, [token]);
  useEffect(() => {
    const socket = io(API, { auth: { token } }); socketRef.current = socket;
    socket.on('conversation:new', () => { void request<Conversation[]>('/api/conversations', token).then(setConversations); });
    socket.on('chat:notification', (payload: { conversationId?: string; message: Message }) => {
      void request<Conversation[]>('/api/conversations', token).then(setConversations);
      if (active && active.id === payload.conversationId) socket.emit('conversation:read', { conversationId: active.id });
    });
    return () => { socket.disconnect(); };
  }, [token, active?.id]);
  useEffect(() => {
    if (!active) { setMessages([]); return; }
    const selectedConversation = active;
    const socket = socketRef.current;
    socket?.emit('conversation:join', selectedConversation.id, (result: { ok: boolean; message?: string }) => { if (!result.ok) setError(result.message ?? 'Could not join this conversation.'); });
    void request<Message[]>(`/api/conversations/${selectedConversation.id}/messages`, token).then(setMessages).catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load messages.'));
    socket?.on('chat:message', receiveMessage);
    socket?.on('chat:updated', updateMessage);
    socket?.on('chat:typing', receiveTyping);
    socket?.on('chat:read', receiveRead);
    socket?.on('conversation:presence', receivePresence);
    socket?.emit('conversation:read', { conversationId: selectedConversation.id });
    return () => { socket?.off('chat:message', receiveMessage); socket?.off('chat:updated', updateMessage); socket?.off('chat:typing', receiveTyping); socket?.off('chat:read', receiveRead); socket?.off('conversation:presence', receivePresence); };
    function receiveMessage(message: Message) { if (message.conversationId !== selectedConversation.id) return; setMessages((items) => [...items, message]); if (message.senderId !== user.id) socket?.emit('conversation:read', { conversationId: selectedConversation.id }); }
    function updateMessage(message: Message) { if (message.conversationId === selectedConversation.id) setMessages((items) => items.map((item) => item.id === message.id ? message : item)); }
    function receiveTyping(data: { userId: string; name: string; isTyping: boolean }) { if (data.userId !== user.id) setTyping(data.isTyping ? `${data.name} is typing…` : ''); }
    function receiveRead(data: { messageIds: string[]; readAt: string }) { const ids = new Set(data.messageIds); setMessages((items) => items.map((message) => ids.has(message.id) ? { ...message, readAt: data.readAt } : message)); }
    function receivePresence(data: { userId: string; online: boolean; lastSeenAt?: string }) { setPresence((items) => ({ ...items, [data.userId]: { online: data.online, lastSeenAt: data.lastSeenAt } })); }
  }, [active?.id, token, user.id]);
  useEffect(() => { messagesEnd.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);
  const visibleMessages = useMemo(() => messages.filter((message) => !query || message.text.toLowerCase().includes(query.toLowerCase()) || message.attachment?.name.toLowerCase().includes(query.toLowerCase())), [messages, query]);

  async function createConversation(event: FormEvent) {
    event.preventDefault(); setError('');
    try {
      const result = await request<{ id: string }>('/api/conversations', token, { method: 'POST', body: JSON.stringify({ participantEmails: participantEmails.split(',').map((email) => email.trim()).filter(Boolean), name: groupName }) });
      const updated = await request<Conversation[]>('/api/conversations', token); setConversations(updated); setActive(updated.find((conversation) => conversation.id === result.id) ?? null); setNewChatOpen(false); setParticipantEmails(''); setGroupName('');
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not create conversation.'); }
  }
  function send(event: FormEvent) {
    event.preventDefault(); if (!active || !draft.trim()) return;
    if (edit) socketRef.current?.emit('chat:edit', { messageId: edit.id, text: draft });
    else socketRef.current?.emit('conversation:send', { conversationId: active.id, text: draft, replyTo: reply?.id });
    setDraft(''); setReply(null); setEdit(null); socketRef.current?.emit('conversation:typing', { conversationId: active.id, isTyping: false });
  }
  const sendFile = async (file?: File) => {
    if (!active || !file) return;
    const form = new FormData(); form.append('file', file);
    try {
      const response = await fetch(`${API}/api/conversations/${active.id}/attachments`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
      const item = await response.json(); if (!response.ok) throw new Error(item.message ?? 'Upload failed.');
      socketRef.current?.emit('conversation:send', { conversationId: active.id, text: '', attachmentKey: item.storageKey });
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not upload file.'); }
  };
  const download = async (message: Message) => {
    if (!message.attachment) return;
    try { const response = await fetch(`${API}${message.attachment.url}`, { headers: { Authorization: `Bearer ${token}` } }); if (!response.ok) throw new Error('Download failed.'); const url = URL.createObjectURL(await response.blob()); const anchor = document.createElement('a'); anchor.href = url; anchor.download = message.attachment.name; anchor.click(); URL.revokeObjectURL(url); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not download the file.'); }
  };

  return <div className="conversation-workspace"><aside className="conversation-list"><div className="conversation-list-heading"><div><div className="eyebrow">MESSAGES</div><h2>Your conversations</h2></div><button className="button button-primary" onClick={() => setNewChatOpen(true)} title="Start a chat"><Plus size={15} /></button></div>{conversations.map((conversation) => <button key={conversation.id} className={`conversation-list-item ${active?.id === conversation.id ? 'active' : ''}`} onClick={() => { setActive(conversation); setError(''); }}><span className="conversation-avatar">{conversation.kind === 'group' ? <Users size={16} /> : otherName(conversation).slice(0, 1).toUpperCase()}</span><span className="conversation-list-copy"><strong>{otherName(conversation)}</strong><small>{conversation.lastMessage?.text || conversation.lastMessage?.attachment?.name || 'Start the conversation'}</small></span>{conversation.unreadCount > 0 && <i className="conversation-unread">{conversation.unreadCount}</i>}</button>)}{!conversations.length && <p className="conversation-empty">Start a one-to-one or group chat.</p>}</aside>
    <section className="conversation-thread">{active ? <><header className="conversation-thread-header"><span className="conversation-avatar">{active.kind === 'group' ? <Users size={16} /> : otherName(active).slice(0, 1).toUpperCase()}</span><div><strong>{otherName(active)}</strong><small>{active.participants.map((person) => { const state = presence[person.id]; return `${person.name}${person.id === user.id ? ' (you)' : state?.online ? ' · online' : state?.lastSeenAt ? ` · last seen ${new Date(state.lastSeenAt).toLocaleString()}` : ''}`; }).join(', ')}</small></div><label className="search-box"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search messages" /></label></header>{error && <div className="form-error">{error}</div>}<div className="conversation-messages">{visibleMessages.map((message) => <article className={`conversation-message ${message.senderId === user.id ? 'own-message' : ''}`} key={message.id}><strong>{message.senderId === user.id ? 'You' : message.senderName}<time>{new Date(message.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}{message.editedAt ? ' · edited' : ''}</time></strong>{message.replyTo && <small>↪ {message.replyTo.senderName}: {message.replyTo.text}</small>}{message.deleted ? <p className="deleted-message">Message deleted</p> : <>{message.text && <p>{message.text}</p>}{message.attachment && <button className="message-attachment" onClick={() => void download(message)}><Paperclip size={14} /> {message.attachment.name}</button>}{message.reactions?.map((reaction, index) => <button key={`${reaction.userId}-${index}`} className="reaction-pill" onClick={() => socketRef.current?.emit('chat:reaction', { messageId: message.id, emoji: reaction.emoji })}>{reaction.emoji}</button>)}<div className="conversation-message-actions"><button onClick={() => setReply(message)}>Reply</button><button onClick={() => socketRef.current?.emit('chat:reaction', { messageId: message.id, emoji: '👍' })}>👍</button>{message.senderId === user.id && <><button onClick={() => { setEdit(message); setDraft(message.text); }}>Edit</button><button onClick={() => socketRef.current?.emit('chat:delete', { messageId: message.id })}>Delete</button></>}</div></>}{message.senderId === user.id && <span className={message.readAt ? 'receipt-read' : ''}>{message.readAt ? '✓✓' : '✓'}</span>}</article>)}{typing && <p className="typing-label">{typing}</p>}<div ref={messagesEnd} /></div>{reply && <div className="chat-context-banner">Replying to {reply.senderName}<button onClick={() => setReply(null)}>Cancel</button></div>}{edit && <div className="chat-context-banner">Editing message<button onClick={() => { setEdit(null); setDraft(''); }}>Cancel</button></div>}<form className="chat-compose" onSubmit={send}><textarea value={draft} onChange={(event) => { setDraft(event.target.value); socketRef.current?.emit('conversation:typing', { conversationId: active.id, isTyping: Boolean(event.target.value) }); }} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(event); } }} placeholder="Write a message…" rows={2} /><div className="compose-footer"><input ref={uploadRef} type="file" hidden accept="image/jpeg,image/png,image/gif,image/webp,application/pdf,text/plain" onChange={(event) => { void sendFile(event.target.files?.[0]); event.target.value = ''; }} /><button type="button" aria-label="Attach file" onClick={() => uploadRef.current?.click()}><Paperclip size={15} /></button><span>Press <kbd>Enter</kbd> to send</span><button type="submit" disabled={!draft.trim()} aria-label="Send"><Send size={16} /></button></div></form></> : <div className="empty-state"><div className="empty-art"><MessageCircle size={23} /></div><h3>Select a conversation</h3><p>Choose a chat, or start a new one with verified users.</p></div>}</section>
    {newChatOpen && <div className="modal-backdrop"><div className="modal-card"><div className="modal-top"><div className="modal-icon"><Users size={20} /></div><button className="icon-button" onClick={() => setNewChatOpen(false)}><X size={18} /></button></div><div className="eyebrow">NEW CONVERSATION</div><h2>Start a chat</h2><p>Enter one email for a direct chat or several for a group.</p><form onSubmit={createConversation}><label className="field-label">Participant emails<input value={participantEmails} onChange={(event) => setParticipantEmails(event.target.value)} required type="text" placeholder="person@example.com, teammate@example.com" /></label>{participantEmails.split(',').filter(Boolean).length > 1 && <label className="field-label">Group name<input value={groupName} onChange={(event) => setGroupName(event.target.value)} maxLength={100} placeholder="Interview panel" /></label>}{error && <div className="form-error">{error}</div>}<div className="modal-actions"><button type="button" className="button button-light" onClick={() => setNewChatOpen(false)}>Cancel</button><button className="button button-primary">Start conversation<ArrowRight size={15} /></button></div></form></div></div>}
  </div>;
}
