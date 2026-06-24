"use client";

import { MessageCircle } from "lucide-react";
import PageHeader, { PageContainer, EmptyState } from "@/components/PageHeader";

// Phase 1 will add: conversation list, realtime chat pane, unread + archive.
export default function MessagesPage() {
  return (
    <div>
      <PageHeader title="Messages" subtitle="Your conversations" />
      <PageContainer>
        <EmptyState
          icon={<MessageCircle className="size-10" />}
          title="Messaging is coming together"
          body="Book or accept a gig to start a conversation. Full chat lands in Phase 1."
        />
      </PageContainer>
    </div>
  );
}
