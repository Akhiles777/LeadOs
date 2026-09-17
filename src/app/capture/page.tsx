import type { Metadata } from "next";
import { CaptureClient } from "@/components/capture-client";

export const metadata: Metadata = { title: "Добавить в LeadOS" };

export default function CapturePage() {
  return (
    <div className="mx-auto max-w-2xl">
      <CaptureClient />
    </div>
  );
}
