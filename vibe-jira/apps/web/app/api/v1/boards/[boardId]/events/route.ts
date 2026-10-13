import { getBoardAccess, subscribeToBoardChanges } from "@vibe/database";
import { assertCapability, DomainError } from "@vibe/domain";
import { correlationId, handleApiError, requireIdentity } from "@/lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface Context {
  params: Promise<{ boardId: string }>;
}

const encoder = new TextEncoder();

function eventFrame(event: string, data: unknown, id?: string): Uint8Array {
  return encoder.encode(
    `${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
  );
}

export async function GET(
  request: Request,
  context: Context,
): Promise<Response> {
  const requestId = correlationId(request);
  try {
    const identity = await requireIdentity();
    const { boardId } = await context.params;
    const access = await getBoardAccess(identity.id, boardId);
    if (!access)
      throw new DomainError("BOARD_NOT_FOUND", "Board not found", 404);
    assertCapability(access.organizationRole, access.projectRole, "issue:view");

    let closeStream = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        let unsubscribe = () => {};
        const heartbeat = setInterval(() => {
          if (!closed) controller.enqueue(encoder.encode(": heartbeat\n\n"));
        }, 15_000);
        const close = () => {
          if (closed) return;
          closed = true;
          clearInterval(heartbeat);
          unsubscribe();
          try {
            controller.close();
          } catch {
            // The browser may already have canceled the stream.
          }
        };
        closeStream = close;
        request.signal.addEventListener("abort", close, { once: true });
        controller.enqueue(encoder.encode("retry: 2000\n\n"));
        controller.enqueue(eventFrame("board.sync", { boardId }));

        void subscribeToBoardChanges(access.projectId, (message) => {
          if (closed) return;
          if (message.type === "sync") {
            controller.enqueue(eventFrame("board.sync", { boardId }));
            return;
          }
          const { event } = message;
          controller.enqueue(
            eventFrame(
              "board.changed",
              event,
              `${event.entity}:${event.entityId}:${event.version}`,
            ),
          );
        })
          .then((stop) => {
            if (closed) stop();
            else unsubscribe = stop;
          })
          .catch((error: unknown) => {
            if (!closed) controller.error(error);
            close();
          });
      },
      cancel() {
        closeStream();
      },
    });

    return new Response(stream, {
      headers: {
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "content-type": "text/event-stream; charset=utf-8",
        "x-accel-buffering": "no",
        "x-correlation-id": requestId,
      },
    });
  } catch (error) {
    return handleApiError(error, requestId);
  }
}
