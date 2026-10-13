import {
  listNotifications,
  processNotificationOutboxBatch,
} from "@vibe/database";
import { redirect } from "next/navigation";
import { NotificationCenter } from "@/components/notification-center";
import { currentIdentity } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function NotificationsPage() {
  const identity = await currentIdentity();
  if (!identity) redirect("/login");
  await processNotificationOutboxBatch(100);
  const center = await listNotifications(identity, { limit: 25 });
  return (
    <NotificationCenter
      displayName={identity.displayName}
      initialCenter={center}
    />
  );
}
