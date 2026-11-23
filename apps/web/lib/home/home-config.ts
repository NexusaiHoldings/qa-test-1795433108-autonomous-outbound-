/**
 * home-config — the company's root surface (company-root-landing-001 +
 * homepage-composition-001). Written by provisioning (_step_substrate_install)
 * from the homepage composer / CTO home_mode + CMO positioning. Do NOT hand-edit.
 */
export interface HomeCta {
  label: string;
  href: string;
}

export interface HomeFeature {
  title: string;
  body: string;
}

export interface SectionImage {
  url?: string;
  alt?: string;
  caption?: string;
}

export interface HeroSection {
  type: "hero";
  eyebrow?: string;
  headline: string;
  subhead?: string;
  primaryCta?: HomeCta;
  secondaryCta?: HomeCta;
  image?: SectionImage;
}
export interface StatsSection {
  type: "stats";
  title?: string;
  stats: { value: string; label: string }[];
}
export interface HowItWorksSection {
  type: "how_it_works";
  title?: string;
  subhead?: string;
  steps: { title: string; body: string }[];
}
export interface FeatureGridSection {
  type: "feature_grid";
  title?: string;
  subhead?: string;
  features: HomeFeature[];
}
export interface FeatureSpotlightSection {
  type: "feature_spotlight";
  title?: string;
  items: { title: string; body: string; image?: SectionImage }[];
}
export interface SocialProofSection {
  type: "social_proof";
  title?: string;
  quotes: { quote: string; author?: string; role?: string }[];
}
export interface FaqSection {
  type: "faq";
  title?: string;
  items: { q: string; a: string }[];
}
export interface PricingTeaserSection {
  type: "pricing_teaser";
  title?: string;
  subhead?: string;
  tiers: {
    name: string;
    price?: string;
    period?: string;
    features: string[];
    cta?: HomeCta;
    highlighted?: boolean;
  }[];
}
export interface GallerySection {
  type: "gallery";
  title?: string;
  images: SectionImage[];
}
export interface CtaBandSection {
  type: "cta_band";
  headline: string;
  subhead?: string;
  cta?: HomeCta;
}

export type HomeSection =
  | HeroSection
  | StatsSection
  | HowItWorksSection
  | FeatureGridSection
  | FeatureSpotlightSection
  | SocialProofSection
  | FaqSection
  | PricingTeaserSection
  | GallerySection
  | CtaBandSection;

export interface HomeConfig {
  mode: "landing" | "conversation";
  sections?: HomeSection[];
  headline?: string;
  subhead?: string;
  primaryCta?: HomeCta;
  secondaryCta?: HomeCta;
  featuresTitle?: string;
  features?: HomeFeature[];
  closingHeadline?: string;
}

export const homeConfig: HomeConfig = {
  "mode": "landing",
  "headline": "Your first booked meeting this week \u2014 without hiring an SDR, without learning another platform.\u2026",
  "subhead": "An autonomous outbound agent for founder-led legal, accounting, and IT consulting firms that does the entire 'find, validate, write, send, follow up' job on its own and hands over only when a meeting is actually booked on the founder's\u2026",
  "sections": [
    {
      "type": "hero",
      "headline": "Your First SDR. No Salary, No Equity, No Headaches.",
      "eyebrow": "AI-Powered Outbound for B2B Service Firms",
      "subhead": "An autonomous AI agent that researches prospects, writes personalized cold emails, follows up, and books meetings directly into your calendar \u2014 for $499/mo flat.",
      "primaryCta": {
        "label": "Book a Demo",
        "href": "/demo"
      },
      "secondaryCta": {
        "label": "See How It Works",
        "href": "#how-it-works"
      },
      "image": {
        "url": "hero_image"
      }
    },
    {
      "type": "stats",
      "stats": [
        {
          "value": "12M+",
          "label": "US SMBs in your target ICP"
        },
        {
          "value": "$80K",
          "label": "Avg. SDR salary you're not paying"
        },
        {
          "value": "3\u20135",
          "label": "Qualified meetings booked per week"
        },
        {
          "value": "48 hrs",
          "label": "From signup to first email sent"
        }
      ],
      "title": "Outbound That Actually Moves the Needle"
    },
    {
      "type": "how_it_works",
      "steps": [
        {
          "title": "Define Your Ideal Client",
          "body": "You tell us your target \u2014 industry, company size, geography. We configure your ICP in the platform in under 30 minutes."
        },
        {
          "title": "AI Researches and Builds Your List",
          "body": "Our agent scrapes Apollo, LinkedIn, and recent company news to surface high-fit prospects and pull the context needed for a genuinely personal email."
        },
        {
          "title": "Personalized Emails Go Out Automatically",
          "body": "The AI drafts and sends cold emails referencing real prospect signals \u2014 a recent hire, a funding round, a news mention \u2014 then handles up to three follow-up touches per thread."
        },
        {
          "title": "Meetings Land on Your Calendar",
          "body": "Interested replies are handled by the agent, which qualifies the lead and books a call directly into your calendar. You show up; we did the rest."
        }
      ],
      "title": "From Zero to Booked Meetings in Days",
      "subhead": "No SDR to hire, no playbook to build. Tell us your ICP and we handle everything end to end."
    },
    {
      "type": "feature_spotlight",
      "items": [
        {
          "title": "Research That Would Take a Human Hours",
          "body": "Before every email, the agent cross-references Apollo data, LinkedIn activity, and live company news to find a genuine hook. No mail-merge spray-and-pray \u2014 each message reads like it was written by someone who did their homework."
        },
        {
          "title": "Autonomous Follow-Up That Doesn't Quit",
          "body": "Most deals die in the follow-up. Our agent sends up to three contextual reply touches per prospect, spacing them intelligently and adjusting tone based on prior engagement \u2014 so no warm lead goes cold because you got busy."
        },
        {
          "title": "Calendar-Native Meeting Booking",
          "body": "When a prospect says yes, the agent handles scheduling end-to-end \u2014 no back-and-forth, no Calendly link buried in an email. The meeting appears in your Google or Outlook calendar, confirmed and ready."
        }
      ],
      "title": "Built for Founders Who Sell"
    },
    {
      "type": "feature_grid",
      "features": [
        {
          "title": "Apollo + LinkedIn Data Sourcing",
          "body": "Continuously pulls fresh prospect data from Apollo's 275M+ contact database and LinkedIn to keep your pipeline full."
        },
        {
          "title": "AI Copywriting Engine",
          "body": "Generates cold emails tuned for legal, accounting, and IT consulting contexts \u2014 professional, concise, and never robotic."
        },
        {
          "title": "Multi-Touch Reply Sequences",
          "body": "Sends up to three follow-up touches per thread, timed and worded to feel human without requiring you to lift a finger."
        },
        {
          "title": "Live Company News Triggers",
          "body": "Monitors news feeds for hiring surges, leadership changes, and funding events \u2014 so your outreach lands at exactly the right moment."
        },
        {
          "title": "Google & Outlook Calendar Sync",
          "body": "Reads your real-time availability and books confirmed meetings directly, eliminating all scheduling friction."
        },
        {
          "title": "Pipeline Dashboard",
          "body": "Track emails sent, open rates, replies, and meetings booked in a single clean view \u2014 no CRM configuration required."
        }
      ],
      "title": "Everything Your Outbound Motion Needs",
      "subhead": "One flat subscription. No seat fees, no per-email charges, no hidden setup costs."
    },
    {
      "type": "social_proof",
      "quotes": [
        {
          "quote": "I was spending Sunday nights manually researching prospects and writing cold emails. Now I open Monday morning to two or three meeting requests already on my calendar. It's a completely different business.",
          "author": "Managing Partner",
          "role": "Boutique IT consulting firm, Austin TX"
        },
        {
          "quote": "We looked at hiring a junior SDR but couldn't justify the risk. This gave us the same outbound motion at a fraction of the cost, and the personalization is genuinely impressive \u2014 prospects comment on it.",
          "author": "Founder",
          "role": "CPA firm specializing in SaaS clients, Chicago IL"
        },
        {
          "quote": "As a solo employment attorney, business development always came last. Having an agent that handles prospecting autonomously means I'm finally growing the practice without sacrificing billable hours.",
          "author": "Principal Attorney",
          "role": "Employment law practice, Denver CO"
        }
      ],
      "title": "What Founders Are Saying"
    },
    {
      "type": "pricing_teaser",
      "tiers": [
        {
          "name": "Starter",
          "features": [
            "Up to 500 prospects researched per month",
            "AI-personalized cold email sequences",
            "2-touch automated follow-up per prospect",
            "Google or Outlook calendar booking",
            "Pipeline dashboard"
          ],
          "price": "$499",
          "period": "mo"
        },
        {
          "name": "Growth",
          "features": [
            "Up to 1,500 prospects researched per month",
            "3-touch automated follow-up per prospect",
            "Live company news triggers for timing",
            "A/B subject line testing",
            "Priority email support"
          ],
          "price": "$899",
          "period": "mo",
          "highlighted": true
        },
        {
          "name": "Scale",
          "features": [
            "Unlimited prospects researched per month",
            "Multi-inbox sending for higher deliverability",
            "Custom ICP refinement sessions",
            "CRM integration (HubSpot, Pipedrive)",
            "Dedicated account manager"
          ],
          "price": "$1,499",
          "period": "mo"
        }
      ],
      "title": "Simple, Flat-Rate Pricing",
      "subhead": "No per-seat fees, no long-term contracts. Pick the tier that matches where your firm is today."
    },
    {
      "type": "faq",
      "items": [
        {
          "q": "Will the emails actually sound like me, or obviously like AI?",
          "a": "The agent writes in a professional, consultative tone calibrated for service firms \u2014 not the robotic blasts prospects delete instantly. Every email references a real, specific detail about the prospect pulled from LinkedIn or recent news. You can review and edit the tone settings at any time."
        },
        {
          "q": "How does it get prospect contact data? Is it compliant?",
          "a": "We source data from Apollo, which aggregates publicly available business contact information. All outreach follows CAN-SPAM guidelines \u2014 every email includes a one-click unsubscribe, and opt-outs are honored immediately."
        },
        {
          "q": "What happens when a prospect replies? Does AI keep responding?",
          "a": "The agent handles standard follow-up sequences autonomously. If a reply signals genuine interest or asks a nuanced question, it flags the thread for you to take over \u2014 you're never out of the loop on a hot lead."
        },
        {
          "q": "How long until I see my first booked meeting?",
          "a": "Most customers are fully configured and sending within 48 hours of signing up. First meetings typically appear on the calendar within the first two weeks, depending on your ICP and market."
        },
        {
          "q": "Can I cancel anytime?",
          "a": "Yes. There are no annual contracts required on Starter or Growth. You can cancel before your next billing date with no penalty. Scale tier includes an optional annual commitment for a discounted rate."
        }
      ],
      "title": "Common Questions"
    },
    {
      "type": "cta_band",
      "headline": "Your Next Client Is Already Out There. Let's Go Find Them.",
      "subhead": "Join hundreds of founder-led firms running autonomous outbound for less than the cost of one sales lunch a day."
    }
  ]
};
