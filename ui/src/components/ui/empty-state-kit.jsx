"use client";
import { ArrowLeft, FileQuestion, Inbox, LockKeyhole, PackageOpen, RotateCcw, SearchX, ShoppingBag } from "lucide-react";
const STATES = {
  inbox: { title: "You\u2019re all caught up", description: "New conversations and updates will appear here.", action: "Refresh inbox", icon: Inbox },
  search: { title: "No results found", description: "Try a different keyword or remove one of your filters.", action: "Clear search", icon: SearchX },
  cart: { title: "Your cart is empty", description: "Save items here and return when you\u2019re ready to check out.", action: "Explore products", icon: ShoppingBag },
  error: { title: "This page wandered off", description: "The address may be incorrect, or the page may have moved.", action: "Go back", icon: FileQuestion },
  permissions: { title: "Access required", description: "Ask a workspace admin for permission to view this area.", action: "Request access", icon: LockKeyhole },
  generic: { title: "Nothing here yet", description: "Create your first item to get this space started.", action: "Create new", icon: PackageOpen }
};
function EmptyStatesSet({ type = "generic", title, description, actionLabel, onAction, className }) {
  const state = STATES[type];
  const Icon = state.icon;
  const ActionIcon = type === "error" ? ArrowLeft : type === "inbox" ? RotateCcw : null;
  return <section className={`flex min-h-80 w-full items-center justify-center rounded-2xl border border-dashed border-zinc-300 bg-white px-6 py-12 text-center dark:border-zinc-700 dark:bg-zinc-950 ${className ?? ""}`}>
      <div className="max-w-xs">
        <span className="relative mx-auto grid size-12 place-items-center rounded-xl border border-zinc-200 bg-zinc-50 text-zinc-600 shadow-[0_1px_2px_rgba(0,0,0,.04)] dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
          <Icon className="size-5" strokeWidth={1.6} />
          <span className="absolute -bottom-1 -right-1 size-2.5 rounded-full border-2 border-white bg-zinc-300 dark:border-zinc-950 dark:bg-zinc-700" />
        </span>
        <h2 className="mt-4 text-[15px] font-semibold tracking-[-.015em] text-zinc-900 dark:text-zinc-100">{title ?? state.title}</h2>
        <p className="mx-auto mt-1.5 text-[12.5px] leading-5 text-zinc-500 dark:text-zinc-400">{description ?? state.description}</p>
        <button type="button" onClick={onAction} className="mt-5 inline-flex h-9 items-center gap-1.5 rounded-lg bg-zinc-950 px-3.5 text-[12px] font-medium text-white shadow-sm transition-[transform,background-color] hover:bg-zinc-800 active:scale-[.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 focus-visible:ring-offset-2 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200 dark:focus-visible:ring-offset-zinc-950">
          {ActionIcon ? <ActionIcon className="size-3.5" /> : null}{actionLabel ?? state.action}
        </button>
      </div>
    </section>;
}
export {
  EmptyStatesSet
};
