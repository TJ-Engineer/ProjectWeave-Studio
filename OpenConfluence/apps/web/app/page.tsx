import { redirect } from "next/navigation";
import { currentIdentity } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  redirect((await currentIdentity()) ? "/spaces" : "/login");
}
