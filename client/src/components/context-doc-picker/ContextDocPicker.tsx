/* ContextDocPicker — the shared attachment surface for project-context
   documents, used by the agent editor's Context tab and the skill editor's
   "Project context to use" section.

   It owns discovery and preview; the caller owns the attachment itself, because
   an agent and a skill persist through different endpoints. Only what BOTH call
   sites demonstrably need lives here. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Checkbox, EmptyState, ErrorState, Icon, SelectInput, Skeleton } from "@devdigest/ui";
import { useRepos } from "../../lib/hooks/core";
import {
  useContextDocumentContent,
  useContextDocuments,
  useContextSearchRoots,
} from "../../lib/hooks/project-context";
import { attachedPathsFor, filterDocs, togglePath, toKb, type AttachedDoc } from "./helpers";
import { s } from "./styles";

export function ContextDocPicker({
  attached,
  onSave,
  saving = false,
  variant,
}: {
  /** Every attachment the owner (agent or skill) has, across all repositories. */
  attached: AttachedDoc[];
  /** Persist the new ordered path set FOR ONE repository. */
  onSave: (repoId: string, paths: string[]) => void;
  saving?: boolean;
  /**
   * Which call site this is. It selects the heading and the blurb, and nothing
   * else — the two surfaces are otherwise the same, which is why this component
   * exists rather than two forks. The skill heading is "Project context to
   * use", which is the exact wording AC-08 is checked on.
   */
  variant: "agent" | "skill";
}) {
  const t = useTranslations("context");
  const repos = useRepos();

  const [repoId, setRepoId] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState("");
  // Selecting a row opens the preview. It is deliberately separate from the
  // checkbox: previewing must never attach (AC-06).
  const [selected, setSelected] = React.useState<string | null>(null);

  // Default to the first repository once the list lands. Derived rather than
  // mirrored: the picker is the only writer of this piece of state.
  const effectiveRepoId = repoId ?? repos.data?.[0]?.id ?? null;

  const documents = useContextDocuments(effectiveRepoId);
  const roots = useContextSearchRoots(effectiveRepoId);
  const preview = useContextDocumentContent(effectiveRepoId, selected);

  const attachedPaths = attachedPathsFor(attached, effectiveRepoId);
  const visible = filterDocs(documents.data ?? [], query);

  const onRepoChange = (next: string) => {
    setRepoId(next);
    // The preview belongs to the old repository; a stale one would read as the
    // new repo's document.
    setSelected(null);
    setQuery("");
  };

  const onToggle = (path: string, attach: boolean) => {
    if (!effectiveRepoId) return;
    onSave(effectiveRepoId, togglePath(attachedPaths, path, attach));
  };

  return (
    <div>
      <div style={s.header}>
        <h2 style={s.title}>{t(variant === "skill" ? "sectionTitle" : "title")}</h2>
      </div>
      <p style={s.subtitle}>{t(variant === "skill" ? "skillSubtitle" : "subtitle")}</p>

      <div style={s.repoRow}>
        <span style={s.repoLabel}>{t("repoLabel")}</span>
        <div style={s.repoSelect}>
          <SelectInput
            value={effectiveRepoId ?? ""}
            onChange={onRepoChange}
            options={(repos.data ?? []).map((r) => ({ value: r.id, label: r.full_name }))}
            mono={false}
          />
        </div>
        <div style={s.search}>
          <Icon.Search size={13} style={{ color: "var(--text-muted)" }} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("filterPlaceholder")}
            aria-label={t("filterPlaceholder")}
            style={s.searchInput}
          />
        </div>
      </div>

      {!effectiveRepoId ? (
        <EmptyState icon="Folder" title={t("empty.title")} body={t("empty.noRepo")} />
      ) : documents.isError ? (
        <ErrorState body={t("loadError")} onRetry={() => void documents.refetch()} />
      ) : documents.isLoading ? (
        <div style={s.list}>
          <Skeleton height={44} />
          <Skeleton height={44} />
          <Skeleton height={44} />
        </div>
      ) : (documents.data ?? []).length === 0 ? (
        <EmptyState icon="Folder" title={t("empty.title")} body={t("empty.body")} />
      ) : (
        <div style={s.split}>
          <div style={s.list}>
            {visible.map((doc) => (
              <div
                key={doc.path}
                data-testid={`context-doc-${doc.path}`}
                style={s.row(attachedPaths.includes(doc.path), selected === doc.path)}
              >
                <Checkbox
                  checked={attachedPaths.includes(doc.path)}
                  onChange={(v) => onToggle(doc.path, v)}
                />
                <button
                  type="button"
                  onClick={() => setSelected(doc.path)}
                  aria-label={t("previewTitle") + ": " + doc.path}
                  style={s.pathButton}
                  className="mono"
                >
                  {doc.path}
                </button>
                <span style={s.typeChip}>{doc.type}</span>
                <span style={s.size}>{t("size", { kb: toKb(doc.bytes) })}</span>
              </div>
            ))}
          </div>

          <div style={s.preview} data-testid="context-preview">
            <div style={s.previewTitle}>{selected ?? t("previewTitle")}</div>
            <div style={s.previewHint}>{t("previewHint")}</div>
            {!selected ? (
              <p style={s.previewBody}>{t("previewEmpty")}</p>
            ) : preview.isError ? (
              <p style={s.previewBody}>{t("previewLoadError")}</p>
            ) : preview.isLoading ? (
              <Skeleton height={120} />
            ) : (
              <pre style={s.previewBody}>{preview.data?.content}</pre>
            )}
          </div>
        </div>
      )}

      {roots.data && <p style={s.trust}>{t("searchRootsHint", { roots: roots.data.search_roots.join(", ") })}</p>}
      <p style={s.trust}>{t("trust")}</p>
      <div style={s.footer}>
        <span style={s.savedNote}>{saving ? t("saving") : t("autoSaved")}</span>
      </div>
    </div>
  );
}
