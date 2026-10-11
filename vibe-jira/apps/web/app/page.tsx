import { redirect } from "next/navigation";
import { currentIdentity } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function HomePage(): Promise<never> {
  const identity = await currentIdentity();
  redirect(identity ? "/projects" : "/login");
}
