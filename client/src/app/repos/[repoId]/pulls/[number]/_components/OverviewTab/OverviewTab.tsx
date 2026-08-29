/* OverviewTab — the PR Brief surface: the brief card first (the summary a
   reviewer reads before the detail), then Intent and Blast Radius side by side
   (stacking on narrow viewports), the PR description below. */
"use client";

import React from "react";
import { SectionLabel } from "@devdigest/ui";
import { PrBriefCard } from "../PrBriefCard";
import { IntentCard } from "../IntentCard";
import { BlastCard } from "../BlastCard";
import { s } from "./styles";

interface OverviewTabProps {
  prId: string | null;
  /** The PR's current head — IntentCard marks a stale classification with it. */
  headSha?: string | null;
  prBody: string | null | undefined;
  /** A brief review-focus item was activated — the page deep-links into the
   *  Files-changed tab from here. */
  onFocusFile: (file: string, line?: number | null) => void;
}

export function OverviewTab({ prId, headSha, prBody, onFocusFile }: OverviewTabProps) {
  return (
    <>
      <PrBriefCard prId={prId} onFocusFile={onFocusFile} />

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
