import type { Metadata } from "next";
import SubmitAppPageClient from "./SubmitAppPageClient";

export const metadata: Metadata = {
  title: "Mithaq — Submit an App",
  description:
    "Submit your Mithaq integration for review and listing in the Apps gallery.",
};

export default function Page() {
  return <SubmitAppPageClient />;
}
