import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

// shadcn class-merge helper.
export function cn(...inputs) {
  return twMerge(clsx(inputs));
}
