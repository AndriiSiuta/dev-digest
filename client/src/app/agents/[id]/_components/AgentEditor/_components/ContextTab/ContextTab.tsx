/* ContextTab — the repository documents this agent reads with every review.
   Attachment is per (agent, repo): the picker's repo selection scopes every
   tick, and switching repositories never disturbs the other one's set. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import type { Agent } from "@devdigest/shared";
import { ContextDocPicker } from "../../../../../../../components/context-doc-picker";
import {
  useAgentContextDocs,
  useSetAgentContextDocs,
} from "../../../../../../../lib/hooks/project-context";
import { useToast } from "../../../../../../../lib/toast";

export function ContextTab({ agent }: { agent: Agent }) {
  const t = useTranslations("context");
  const toast = useToast();
  const attached = useAgentContextDocs(agent.id);
  const save = useSetAgentContextDocs();

  return (
    <ContextDocPicker
      variant="agent"
      attached={attached.data ?? []}
      saving={save.isPending}
      onSave={(repoId, paths) =>
        save.mutate(
          { agentId: agent.id, repoId, docs: paths.map((path) => ({ path })) },
          { onError: () => toast.error(t("saveError")) },
        )
      }
    />
  );
}
