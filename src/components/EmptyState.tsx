import type { ReactNode } from "react";
import type { RemixiconComponentType } from "@remixicon/react";

/** 空状态：图标、一句标题、一句说明，最多一个次要动作。 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon?: RemixiconComponentType;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 text-center">
      {Icon ? (
        <span className="flex size-10 items-center justify-center rounded-xl border border-separator-border bg-background-secondary-default">
          <Icon className="size-[18px] text-text-tertiary" aria-hidden />
        </span>
      ) : null}
      <div>
        <p className="text-body-medium text-text-primary">{title}</p>
        {description ? (
          <p className="mx-auto mt-1 max-w-md text-body-2-regular text-text-tertiary">{description}</p>
        ) : null}
      </div>
      {action}
    </div>
  );
}
