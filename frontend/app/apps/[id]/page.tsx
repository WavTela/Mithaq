import type { Metadata } from "next";
import { Suspense } from "react";
import { getProtocol } from "@/lib/protocols";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const protocol = getProtocol(id);
  if (!protocol) {
    return {
      title: "Mithaq — Protocol not found",
      description: "The requested Mithaq protocol could not be found.",
    };
  }

  return {
    title: `Mithaq — ${protocol.name}`,
    description: protocol.tagline,
    openGraph: {
      title: `Mithaq — ${protocol.name}`,
      description: protocol.tagline,
      siteName: "Mithaq",
      type: "website",
    },
    twitter: {
      card: "summary",
      title: `Mithaq — ${protocol.name}`,
      description: protocol.tagline,
    },
  };
}

import ProtocolDetailClient from "./ProtocolDetailClient";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense fallback={null}>
      <ProtocolDetailClient id={id} />
    </Suspense>
  );
}
