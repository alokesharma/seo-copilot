"use client";
import * as React from "react";
import { cn } from "@/lib/utils";
function useSafePathname() {
  const [pathname, setPathname] = React.useState("");
  React.useEffect(() => {
    if (typeof window !== "undefined") {
      setPathname(window.location.pathname);
    }
  }, []);
  return pathname;
}
function NavItemRenderer({ item, pathname, depth }) {
  const hasChildren = item.items && item.items.length > 0;
  const isActive = pathname === item.href;
  if (hasChildren) {
    return <div className="space-y-1">
        <div
      className={cn(
        "flex items-center gap-2 text-sm",
        depth === 0 && "px-3 py-2 font-semibold text-foreground",
        depth > 0 && "px-3 py-1.5 font-medium text-muted-foreground"
      )}
    >
          {item.icon && <item.icon className={cn(depth === 0 ? "h-4 w-4" : "h-3.5 w-3.5")} />}
          {item.title}
        </div>
        <div className={cn("ml-4 space-y-1 border-l border-border pl-2")}>
          {item.items.map((subItem, index) => <NavItemRenderer
      key={subItem.href !== "#" ? subItem.href : `${subItem.title}-${index}`}
      item={subItem}
      pathname={pathname}
      depth={depth + 1}
    />)}
        </div>
      </div>;
  }
  return <a
    href={item.href}
    className={cn(
      "flex items-center gap-2 text-sm rounded-md transition-colors",
      depth === 0 && "px-3 py-2",
      depth > 0 && "px-3 py-1.5",
      isActive ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
    )}
  >
      {item.icon && <item.icon className={cn(depth === 0 ? "h-4 w-4" : "h-3.5 w-3.5")} />}
      {item.title}
    </a>;
}
function SidebarLight({ items, className }) {
  const pathname = useSafePathname();
  return <aside className={cn("w-full", className)}>
      <nav className="space-y-1">
        {items.map((item, index) => <NavItemRenderer
    key={item.href !== "#" ? item.href : `${item.title}-${index}`}
    item={item}
    pathname={pathname}
    depth={0}
  />)}
      </nav>
    </aside>;
}
var sidebar_light_default = SidebarLight;
export {
  SidebarLight,
  sidebar_light_default as default
};
