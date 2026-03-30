import { getSession, getSessionMessages, deleteSession } from "@/lib/db";

// GET /api/sessions/[id] — Load a session with all its messages
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession(id);

  if (!session) {
    return Response.json({ error: "Session not found" }, { status: 404 });
  }

  const messages = await getSessionMessages(id);
  return Response.json({ session, messages });
}

// DELETE /api/sessions/[id] — Delete a session and its messages
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await deleteSession(id);
  return Response.json({ success: true });
}
