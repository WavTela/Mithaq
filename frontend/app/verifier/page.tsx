import type { Metadata } from "next";
import VerifierPageClient from "./VerifierPageClient";

export const metadata: Metadata = {
  title: "Mithaq — Verifier demo",
  description: "See how protocols check zero-knowledge credential proofs on-chain without seeing the underlying data.",
};

export default function Page() {
  return <VerifierPageClient />;
}
