// ============================================================================
// KA-POSONG BUSINESS TIERS & HARD QUOTA ENFORCEMENT ENGINE (src/tiers.rs)
// ============================================================================

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "UPPERCASE")]
pub enum BusinessTier {
    #[serde(alias = "Starter", alias = "starter")]
    Starter,
    #[serde(alias = "Growth", alias = "growth")]
    Growth,
    #[serde(alias = "Enterprise", alias = "enterprise")]
    Enterprise,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TierLimits {
    pub tier_code: String,
    pub max_domains: i64,
    pub max_mailboxes: i64,
    pub quota_bytes: i64,
    pub outbound_daily_limit: i64,
    pub allow_extending_arms: bool,
    pub modules_description: String,
}

impl BusinessTier {
    pub fn as_str(&self) -> &'static str {
        match self {
            BusinessTier::Starter => "STARTER",
            BusinessTier::Growth => "GROWTH",
            BusinessTier::Enterprise => "ENTERPRISE",
        }
    }

    pub fn from_str_code(code: &str) -> Self {
        match code.trim().to_uppercase().as_str() {
            "GROWTH" | "PRO" => BusinessTier::Growth,
            "ENTERPRISE" => BusinessTier::Enterprise,
            _ => BusinessTier::Starter,
        }
    }

    pub fn limits(&self) -> TierLimits {
        match self {
            BusinessTier::Starter => TierLimits {
                tier_code: "STARTER".into(),
                max_domains: 1,
                max_mailboxes: 5,
                quota_bytes: 5 * 1024 * 1024 * 1024, // 5 GB
                outbound_daily_limit: 100,
                allow_extending_arms: false,
                modules_description: "uMail PWA + Webmail Only".into(),
            },
            BusinessTier::Growth => TierLimits {
                tier_code: "GROWTH".into(),
                max_domains: 3,
                max_mailboxes: 25,
                quota_bytes: 50 * 1024 * 1024 * 1024, // 50 GB
                outbound_daily_limit: 1_000,
                allow_extending_arms: true,
                modules_description: "uMail PWA + CalDAV/CardDAV + CRM Sync + WhatsApp OTP".into(),
            },
            BusinessTier::Enterprise => TierLimits {
                tier_code: "ENTERPRISE".into(),
                max_domains: 999,
                max_mailboxes: 10_000,
                quota_bytes: 500 * 1024 * 1024 * 1024, // 500 GB+
                outbound_daily_limit: 50_000,
                allow_extending_arms: true,
                modules_description: "All Modules + Custom Webhook Arms + Dedicated Relay Option".into(),
            },
        }
    }
}
