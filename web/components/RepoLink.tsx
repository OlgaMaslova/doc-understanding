import { REPO_URL } from "@/lib/site";

/**
 * The link that replaced the run flow.
 *
 * On the deployed site there is no pipeline and no key, so every place that used to
 * offer a button now offers the repository instead. One component, so the URL is
 * stated once and every one of those places reads the same.
 *
 * Two variants because the places differ: mid-sentence, where it has to look like a
 * link, and standing alone at the end of a section, where it inherits the shape of
 * the button it replaced. They are variants rather than a `className` override —
 * underlined and not-underlined are the same Tailwind property, and which one wins
 * would come down to stylesheet order rather than intent.
 */
export function RepoLink({
  children,
  variant = "inline",
  className = "",
}: {
  children: React.ReactNode;
  variant?: "inline" | "button";
  className?: string;
}) {
  const style =
    variant === "button"
      ? "inline-block rounded border border-accent px-3 py-1.5 text-sm text-text transition-colors hover:bg-bg-inset"
      : "text-text underline decoration-border-strong underline-offset-2 hover:decoration-accent";
  return (
    <a
      href={REPO_URL}
      target="_blank"
      rel="noreferrer"
      className={`${style} ${className}`}
    >
      {children}
    </a>
  );
}
