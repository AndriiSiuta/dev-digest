/* ContextSection — "Project context to use": the repository documents any agent
   linking this skill reads with its review. Same attachment surface as the
   agent editor's Context tab, persisted through the skill's own endpoint. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import type { Skill } from "@devdigest/shared";
import { ContextDocPicker } from "../../../../../../components/context-doc-picker";
import {
  useSetSkillContextDocs,
  useSkillContextDocs,
} from "../../../../../../lib/hooks/project-context";
import { useToast } from "../../../../../../lib/toast";

export function ContextSection({ skill }: { skill: Skill }) {
  const t = useTranslations("context");
  const toast = useToast();
  const attached = useSkillContextDocs(skill.id);
  const save = useSetSkillContextDocs();

  return (
    <ContextDocPicker
      variant="skill"
      attached={attached.data ?? []}
      saving={save.isPending}
      onSave={(repoId, paths) =>
        save.mutate(
          { skillId: skill.id, repoId, docs: paths.map((path) => ({ path })) },
          { onError: () => toast.error(t("saveError")) },
        )
      }
    />
  );
}
