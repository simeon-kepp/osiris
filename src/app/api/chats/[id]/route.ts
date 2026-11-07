import { NextRequest, NextResponse } from 'next/server';
import { currentLogin } from '@/lib/dingirSessionServer';
import { deleteChat, readChat, saveChat, validId } from '@/lib/chat-store';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Ctx) {
  if (!(await currentLogin())) return new NextResponse(null, { status: 404 });
  const { id } = await params;
  if (!validId(id)) return NextResponse.json({ error: 'bad id' }, { status: 400 });
  const chat = await readChat(id);
  return chat ? NextResponse.json(chat) : new NextResponse(null, { status: 404 });
}

/** PUT merges the caller's messages into the stored conversation (by message id). */
export async function PUT(req: NextRequest, { params }: Ctx) {
  const login = await currentLogin();
  if (!login) return new NextResponse(null, { status: 404 });
  const { id } = await params;
  if (!validId(id)) return NextResponse.json({ error: 'bad id' }, { status: 400 });
  let body: { title?: unknown; messages?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'bad json' }, { status: 400 }); }
  const chat = await saveChat(id, login, body.title, body.messages);
  return NextResponse.json({ ok: true, updatedAt: chat.updatedAt, count: chat.messages.length });
}

/** Only the person who started a conversation can delete it. */
export async function DELETE(_req: NextRequest, { params }: Ctx) {
  const login = await currentLogin();
  if (!login) return new NextResponse(null, { status: 404 });
  const { id } = await params;
  if (!validId(id)) return NextResponse.json({ error: 'bad id' }, { status: 400 });
  const chat = await readChat(id);
  if (!chat) return new NextResponse(null, { status: 404 });
  if (chat.author !== login) return NextResponse.json({ error: 'Only the author can delete this conversation.' }, { status: 403 });
  await deleteChat(id);
  return NextResponse.json({ ok: true });
}
