import type { Metadata } from "next";
import VerifyPresetPageClient from "./VerifyPresetPageClient";

export const metadata: Metadata = {
  title: "Verify preset — Mithaq",
  description:
    "Verify a selective disclosure preset shared by a Mithaq holder. Check credential claims on-chain with a single link.",
};

export default function VerifyPresetPage() {
  return <VerifyPresetPageClient />;
}
