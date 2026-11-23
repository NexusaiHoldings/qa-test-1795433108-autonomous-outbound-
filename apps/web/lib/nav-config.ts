/**
 * Navigation configuration consumed by the substrate's <TopNav /> component.
 *
 * <TopNav /> imports NAV_CONFIG to render the sticky nav strip: `primary`
 * links render inline for every signed-in user; `groups` render as labeled
 * dropdown sections. Groups (or individual links) flagged `adminOnly` render
 * only for organization admins, matching the /admin/* route convention.
 *
 * Domain routes (Dashboard, Inbox, Meetings, Campaign & ICP, Prospects,
 * Approvals, Mailbox, Compliance, and the Admin operator pages) are served
 * from the (sdr) carve-out; Home (/) is the substrate landing surface.
 */

export type NavLink = {
  /** URL path the link navigates to. */
  href: string;
  /** Visible label rendered in the nav strip. */
  label: string;
  /** When true, the link renders only for organization admins. */
  adminOnly?: boolean;
};

export type NavGroup = {
  /** Group heading rendered above its links. */
  label: string;
  /** Links contained in the group, in render order. */
  links: NavLink[];
  /** When true, the entire group renders only for organization admins. */
  adminOnly?: boolean;
};

export type NavConfig = {
  /** Top-level links always visible in the primary nav strip. */
  primary: NavLink[];
  /** Grouped link sections rendered after the primary links. */
  groups: NavGroup[];
};

export const NAV_CONFIG: NavConfig = {
  primary: [
    { href: "/", label: "Home" },
    { href: "/dashboard", label: "Dashboard" },
    { href: "/inbox", label: "Inbox" },
    { href: "/meetings", label: "Meetings" },
  ],
  groups: [
    {
      label: "Campaign",
      links: [
        { href: "/campaign", label: "Campaign & ICP" },
        { href: "/prospects", label: "Prospects" },
        { href: "/approvals", label: "Approvals" },
        { href: "/mailbox", label: "Mailbox" },
        { href: "/compliance", label: "Compliance" },
      ],
    },
    {
      label: "Admin",
      adminOnly: true,
      links: [
        {
          href: "/admin/review-queue",
          label: "Review Queue",
          adminOnly: true,
        },
        {
          href: "/admin/deliverability",
          label: "Deliverability",
          adminOnly: true,
        },
      ],
    },
  ],
};
