import { redirect } from "next/navigation";
import { toAppHref } from "@/lib/main-navigation-transition";

export default function SettingsIndexPage() {
  redirect(toAppHref("/settings/general"));
}
