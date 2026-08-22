/* OverviewTab — the PR Brief surface: Intent and Blast Radius side by side
   (stacking on narrow viewports), the PR description below. */
"use client";

import React from "react";
import { SectionLabel } from "@devdigest/ui";
import { IntentCard } from "../IntentCard";
import { BlastCard } from "../BlastCard";
import { s } from "./styles";

interface OverviewTabProps {
  prId: string | null;
  /** The PR's current head — IntentCard marks a stale classification with it. */
  headSha?: string | null;
  prBody: string | null | undefined;
}

export function OverviewTab({ prId, headSha, prBody }: OverviewTabProps) {
  return (
    <>
      <div style={s.briefGrid}>
        <IntentCard prId={prId} headSha={headSha} />
        <BlastCard prId={prId} />
      </div>

      {prBody && (
        <section>
          <SectionLabel icon="MessageSquare">Description</SectionLabel>
          <div style={s.descriptionBox}>{prBody}</div>
        </section>
      )}
    </>
  );
}
