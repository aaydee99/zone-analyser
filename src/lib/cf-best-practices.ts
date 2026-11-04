// Cloudflare best-practice checks from developers.cloudflare.com, each with the page it comes from
// (gathered 2026-11-04). Data only: template-library.ts turns them into template items.

export const CF_DOCS = [
 {
  "id": "cf-ssl-mode-strict",
  "group": "SSL/TLS",
  "title": "SSL/TLS encryption mode is Full (strict)",
  "why": "Full (strict) encrypts Cloudflare-to-origin traffic and validates the origin certificate, so it is the strongest of the modes Cloudflare strongly recommends.",
  "source": "https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/",
  "check": {
   "setting": {
    "id": "ssl",
    "match": "equals",
    "value": "strict"
   }
  }
 },
 {
  "id": "cf-ssl-mode-not-flexible-or-off",
  "group": "SSL/TLS",
  "title": "SSL/TLS encryption mode is not Off or Flexible",
  "why": "Flexible sends origin traffic unencrypted and Off is all cleartext; Cloudflare strongly recommends Full or Full (strict).",
  "source": "https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/",
  "check": {
   "setting": {
    "id": "ssl",
    "match": "one_of",
    "value": "full,strict"
   }
  }
 },
 {
  "id": "cf-min-tls-1-2",
  "group": "SSL/TLS",
  "title": "Minimum TLS version is 1.2 or higher",
  "why": "PCI requires TLS 1.2 and Cloudflare recommends migrating to it (the default is 1.0).",
  "source": "https://developers.cloudflare.com/ssl/reference/protocols/",
  "check": {
   "setting": {
    "id": "min_tls_version",
    "match": "at_least",
    "value": "1.2"
   }
  }
 },
 {
  "id": "cf-tls-1-3-enabled",
  "group": "SSL/TLS",
  "title": "TLS 1.3 is enabled",
  "why": "Cloudflare says TLS 1.3 gives the best security as a general rule ('on' or 'zrt' both enable it).",
  "source": "https://developers.cloudflare.com/ssl/reference/protocols/",
  "check": {
   "setting": {
    "id": "tls_1_3",
    "match": "one_of",
    "value": "on,zrt"
   }
  }
 },
 {
  "id": "cf-hsts-enabled",
  "group": "SSL/TLS",
  "title": "HSTS is enabled",
  "why": "HSTS makes browsers use HTTPS only, which blocks downgrade attacks; enable it only once HTTPS works everywhere.",
  "source": "https://developers.cloudflare.com/ssl/edge-certificates/additional-options/http-strict-transport-security/",
  "check": {
   "setting": {
    "id": "security_header",
    "match": "contains",
    "value": "\"enabled\":true"
   }
  }
 },
 {
  "id": "cf-hsts-max-age-12-months",
  "group": "SSL/TLS",
  "title": "HSTS max-age is 12 months (31536000)",
  "why": "A max-age of at least 12 months is required for HSTS preload lists, and 12 months is the highest value the dashboard offers.",
  "source": "https://developers.cloudflare.com/ssl/edge-certificates/additional-options/http-strict-transport-security/",
  "check": {
   "setting": {
    "id": "security_header",
    "match": "contains",
    "value": "\"max_age\":31536000"
   }
  }
 },
 {
  "id": "cf-hsts-include-subdomains",
  "group": "SSL/TLS",
  "title": "HSTS includeSubDomains is on",
  "why": "It applies the HSTS policy to every subdomain; Cloudflare warns that subdomains without HTTPS become unreachable.",
  "source": "https://developers.cloudflare.com/ssl/edge-certificates/additional-options/http-strict-transport-security/",
  "check": {
   "setting": {
    "id": "security_header",
    "match": "contains",
    "value": "\"include_subdomains\":true"
   }
  }
 },
 {
  "id": "cf-hsts-preload",
  "group": "SSL/TLS",
  "title": "HSTS preload is on",
  "why": "Preload stops an attacker from downgrading the first request to HTTP; Cloudflare warns it makes a site without HTTPS fully unreachable.",
  "source": "https://developers.cloudflare.com/ssl/edge-certificates/additional-options/http-strict-transport-security/",
  "check": {
   "setting": {
    "id": "security_header",
    "match": "contains",
    "value": "\"preload\":true"
   }
  }
 },
 {
  "id": "cf-hsts-nosniff",
  "group": "SSL/TLS",
  "title": "HSTS No-Sniff (X-Content-Type-Options: nosniff) is on",
  "why": "It stops browsers from guessing a content type other than the declared Content-Type.",
  "source": "https://developers.cloudflare.com/ssl/edge-certificates/additional-options/http-strict-transport-security/",
  "check": {
   "setting": {
    "id": "security_header",
    "match": "contains",
    "value": "\"nosniff\":true"
   }
  }
 },
 {
  "id": "cf-always-use-https",
  "group": "SSL/TLS",
  "title": "Always Use HTTPS is on",
  "why": "It redirects every HTTP request to HTTPS at the edge, which avoids the redirect loops that origin-side redirects can cause.",
  "source": "https://developers.cloudflare.com/ssl/edge-certificates/additional-options/always-use-https/",
  "check": {
   "setting": {
    "id": "always_use_https",
    "match": "equals",
    "value": "on"
   }
  }
 },
 {
  "id": "cf-automatic-https-rewrites",
  "group": "SSL/TLS",
  "title": "Automatic HTTPS Rewrites is on",
  "why": "It prevents mixed-content errors by rewriting HTTP links that are reachable over HTTPS.",
  "source": "https://developers.cloudflare.com/ssl/edge-certificates/additional-options/automatic-https-rewrites/",
  "check": {
   "setting": {
    "id": "automatic_https_rewrites",
    "match": "equals",
    "value": "on"
   }
  }
 },
 {
  "id": "cf-authenticated-origin-pulls",
  "group": "SSL/TLS",
  "title": "Authenticated Origin Pulls (zone-level) is on",
  "why": "AOP lets the origin verify that requests come through Cloudflare; zone-level AOP with your own certificate is stricter than the shared global certificate.",
  "source": "https://developers.cloudflare.com/ssl/origin-configuration/authenticated-origin-pull/",
  "check": {
   "setting": {
    "id": "tls_client_auth",
    "match": "equals",
    "value": "on"
   }
  }
 },
 {
  "id": "cf-security-level-not-under-attack",
  "group": "Security settings",
  "title": "Security level is not left on I'm Under Attack",
  "why": "Cloudflare says to use Under Attack mode only during a DDoS attack, because it can break API traffic.",
  "source": "https://developers.cloudflare.com/waf/tools/security-level/",
  "check": {
   "setting": {
    "id": "security_level",
    "match": "not_equals",
    "value": "under_attack"
   }
  }
 },
 {
  "id": "cf-browser-integrity-check",
  "group": "Security settings",
  "title": "Browser Integrity Check is on",
  "why": "It denies requests with headers commonly abused by spammers and challenges missing or non-standard user agents; it is on by default.",
  "source": "https://developers.cloudflare.com/waf/tools/browser-integrity-check/",
  "check": {
   "setting": {
    "id": "browser_check",
    "match": "equals",
    "value": "on"
   }
  }
 },
 {
  "id": "cf-challenge-ttl-min",
  "group": "Security settings",
  "title": "Challenge passage is at least 15 minutes",
  "why": "Cloudflare recommends a challenge passage between 15 and 45 minutes.",
  "source": "https://developers.cloudflare.com/waf/tools/challenge-passage/",
  "check": {
   "setting": {
    "id": "challenge_ttl",
    "match": "at_least",
    "value": "900"
   }
  }
 },
 {
  "id": "cf-challenge-ttl-max",
  "group": "Security settings",
  "title": "Challenge passage is at most 45 minutes",
  "why": "Cloudflare recommends 15 to 45 minutes; a longer cf_clearance lifetime gives more time for clearance reuse.",
  "source": "https://developers.cloudflare.com/waf/tools/challenge-passage/",
  "check": {
   "setting": {
    "id": "challenge_ttl",
    "match": "at_most",
    "value": "2700"
   }
  }
 },
 {
  "id": "cf-email-obfuscation",
  "group": "Security settings",
  "title": "Email Address Obfuscation is on",
  "why": "It hides email addresses from harvesting bots without changing what visitors see; it is on by default.",
  "source": "https://developers.cloudflare.com/waf/tools/scrape-shield/email-address-obfuscation/",
  "check": {
   "setting": {
    "id": "email_obfuscation",
    "match": "equals",
    "value": "on"
   }
  }
 },
 {
  "id": "cf-managed-ruleset-deployed",
  "group": "Managed rules and OWASP",
  "title": "Cloudflare Managed Ruleset is deployed",
  "why": "It is Cloudflare's main managed WAF ruleset and covers broader threats than the Free Managed Ruleset.",
  "source": "https://developers.cloudflare.com/waf/managed-rules/reference/cloudflare-managed-ruleset/",
  "check": {
   "rule": {
    "phase": "http_request_firewall_managed",
    "expect": "present",
    "conditions": [
     {
      "field": "action",
      "match": "equals",
      "value": "execute"
     },
     {
      "field": "action_parameters.id",
      "match": "equals",
      "value": "efb7b8c949ac4650a09736fc376e9aee"
     }
    ]
   }
  }
 },
 {
  "id": "cf-managed-ruleset-enabled",
  "group": "Managed rules and OWASP",
  "title": "Cloudflare Managed Ruleset deployment rule is enabled",
  "why": "A disabled execute rule leaves the zone without managed WAF protection.",
  "source": "https://developers.cloudflare.com/waf/managed-rules/reference/cloudflare-managed-ruleset/",
  "check": {
   "rule": {
    "phase": "http_request_firewall_managed",
    "expect": "present",
    "conditions": [
     {
      "field": "action_parameters.id",
      "match": "equals",
      "value": "efb7b8c949ac4650a09736fc376e9aee"
     },
     {
      "field": "enabled",
      "match": "equals",
      "value": "true"
     }
    ]
   }
  }
 },
 {
  "id": "cf-managed-ruleset-not-all-log",
  "group": "Managed rules and OWASP",
  "title": "Cloudflare Managed Ruleset is not overridden to Log for everything",
  "why": "A ruleset-level action override replaces every rule's default action, so Log turns off all blocking.",
  "source": "https://developers.cloudflare.com/waf/managed-rules/reference/cloudflare-managed-ruleset/",
  "check": {
   "rule": {
    "phase": "http_request_firewall_managed",
    "expect": "absent",
    "conditions": [
     {
      "field": "action_parameters.id",
      "match": "equals",
      "value": "efb7b8c949ac4650a09736fc376e9aee"
     },
     {
      "field": "action_parameters.overrides.action",
      "match": "equals",
      "value": "log"
     }
    ]
   }
  }
 },
 {
  "id": "cf-managed-ruleset-not-enable-all",
  "group": "Managed rules and OWASP",
  "title": "Cloudflare Managed Ruleset does not force-enable every rule",
  "why": "Cloudflare says enabling all rules through a ruleset-level override is not recommended (except for a proof of concept), because it turns on rules that are off by default to avoid false positives.",
  "source": "https://developers.cloudflare.com/waf/managed-rules/reference/cloudflare-managed-ruleset/",
  "check": {
   "rule": {
    "phase": "http_request_firewall_managed",
    "expect": "absent",
    "conditions": [
     {
      "field": "action_parameters.id",
      "match": "equals",
      "value": "efb7b8c949ac4650a09736fc376e9aee"
     },
     {
      "field": "action_parameters.overrides.enabled",
      "match": "equals",
      "value": "true"
     }
    ]
   }
  }
 },
 {
  "id": "cf-managed-ruleset-not-disabled-override",
  "group": "Managed rules and OWASP",
  "title": "Cloudflare Managed Ruleset rules are not all disabled by override",
  "why": "A ruleset-level enabled=false override switches off every managed rule even though the execute rule stays in place.",
  "source": "https://developers.cloudflare.com/waf/managed-rules/",
  "check": {
   "rule": {
    "phase": "http_request_firewall_managed",
    "expect": "absent",
    "conditions": [
     {
      "field": "action_parameters.id",
      "match": "equals",
      "value": "efb7b8c949ac4650a09736fc376e9aee"
     },
     {
      "field": "action_parameters.overrides.enabled",
      "match": "equals",
      "value": "false"
     }
    ]
   }
  }
 },
 {
  "id": "cf-owasp-deployed",
  "group": "Managed rules and OWASP",
  "title": "Cloudflare OWASP Core Ruleset is deployed",
  "why": "It scores requests against OWASP CRS signatures and acts when the threat score passes the threshold.",
  "source": "https://developers.cloudflare.com/waf/managed-rules/reference/owasp-core-ruleset/",
  "check": {
   "rule": {
    "phase": "http_request_firewall_managed",
    "expect": "present",
    "conditions": [
     {
      "field": "action",
      "match": "equals",
      "value": "execute"
     },
     {
      "field": "action_parameters.id",
      "match": "equals",
      "value": "4814384a9e5d4991b9815dcfc25d2f1f"
     }
    ]
   }
  }
 },
 {
  "id": "cf-owasp-enabled",
  "group": "Managed rules and OWASP",
  "title": "OWASP Core Ruleset deployment rule is enabled",
  "why": "A disabled execute rule means no OWASP scoring is applied.",
  "source": "https://developers.cloudflare.com/waf/managed-rules/reference/owasp-core-ruleset/",
  "check": {
   "rule": {
    "phase": "http_request_firewall_managed",
    "expect": "present",
    "conditions": [
     {
      "field": "action_parameters.id",
      "match": "equals",
      "value": "4814384a9e5d4991b9815dcfc25d2f1f"
     },
     {
      "field": "enabled",
      "match": "equals",
      "value": "true"
     }
    ]
   }
  }
 },
 {
  "id": "cf-owasp-not-ruleset-log",
  "group": "Managed rules and OWASP",
  "title": "OWASP Core Ruleset is not overridden to Log at ruleset level",
  "why": "Log only records matches; leaving OWASP in Log means nothing is blocked once tuning is done.",
  "source": "https://developers.cloudflare.com/terraform/additional-configurations/waf-managed-rulesets/",
  "check": {
   "rule": {
    "phase": "http_request_firewall_managed",
    "expect": "absent",
    "conditions": [
     {
      "field": "action_parameters.id",
      "match": "equals",
      "value": "4814384a9e5d4991b9815dcfc25d2f1f"
     },
     {
      "field": "action_parameters.overrides.action",
      "match": "equals",
      "value": "log"
     }
    ]
   }
  }
 },
 {
  "id": "cf-owasp-anomaly-rule-not-log",
  "group": "Managed rules and OWASP",
  "title": "OWASP anomaly score rule is not set to Log",
  "why": "Rule 6179ae15...843b323c is the last OWASP rule and applies the action once the score threshold is passed; Log on it disables enforcement.",
  "source": "https://developers.cloudflare.com/terraform/additional-configurations/waf-managed-rulesets/",
  "check": {
   "rule": {
    "phase": "http_request_firewall_managed",
    "expect": "absent",
    "conditions": [
     {
      "field": "action_parameters.id",
      "match": "equals",
      "value": "4814384a9e5d4991b9815dcfc25d2f1f"
     },
     {
      "field": "action_parameters.overrides.rules[*].id",
      "match": "equals",
      "value": "6179ae15870a4bb7b2d480d4843b323c"
     },
     {
      "field": "action_parameters.overrides.rules[*].action",
      "match": "equals",
      "value": "log"
     }
    ]
   }
  }
 },
 {
  "id": "cf-owasp-threshold-not-low",
  "group": "Managed rules and OWASP",
  "title": "OWASP score threshold is Medium (40, the default) or stricter, not Low (60)",
  "why": "Thresholds are Low 60, Medium 40 (default) and High 25; Low needs a much higher score before it acts.",
  "source": "https://developers.cloudflare.com/waf/managed-rules/reference/owasp-core-ruleset/concepts/",
  "check": {
   "rule": {
    "phase": "http_request_firewall_managed",
    "expect": "absent",
    "conditions": [
     {
      "field": "action_parameters.id",
      "match": "equals",
      "value": "4814384a9e5d4991b9815dcfc25d2f1f"
     },
     {
      "field": "action_parameters.overrides.rules[*].score_threshold",
      "match": "equals",
      "value": "60"
     }
    ]
   }
  }
 },
 {
  "id": "cf-owasp-pl4-disabled",
  "group": "Managed rules and OWASP",
  "title": "OWASP paranoia level 4 rules are disabled",
  "why": "PL1 is the default; with no category overrides all PL1–PL4 rules run, and PL4 usually needs rules disabled for apps with complex input.",
  "source": "https://developers.cloudflare.com/terraform/additional-configurations/waf-managed-rulesets/",
  "check": {
   "rule": {
    "phase": "http_request_firewall_managed",
    "expect": "present",
    "conditions": [
     {
      "field": "action_parameters.id",
      "match": "equals",
      "value": "4814384a9e5d4991b9815dcfc25d2f1f"
     },
     {
      "field": "action_parameters.overrides.categories[*].category",
      "match": "equals",
      "value": "paranoia-level-4"
     },
     {
      "field": "action_parameters.overrides.categories[*].enabled",
      "match": "equals",
      "value": "false"
     }
    ]
   }
  }
 },
 {
  "id": "cf-owasp-pl3-disabled",
  "group": "Managed rules and OWASP",
  "title": "OWASP paranoia level 3 rules are disabled",
  "why": "Higher paranoia levels block more legitimate traffic, and the documented way to set PL2 or lower is to disable the paranoia-level-3 and paranoia-level-4 categories.",
  "source": "https://developers.cloudflare.com/terraform/additional-configurations/waf-managed-rulesets/",
  "check": {
   "rule": {
    "phase": "http_request_firewall_managed",
    "expect": "present",
    "conditions": [
     {
      "field": "action_parameters.id",
      "match": "equals",
      "value": "4814384a9e5d4991b9815dcfc25d2f1f"
     },
     {
      "field": "action_parameters.overrides.categories[*].category",
      "match": "equals",
      "value": "paranoia-level-3"
     },
     {
      "field": "action_parameters.overrides.categories[*].enabled",
      "match": "equals",
      "value": "false"
     }
    ]
   }
  }
 },
 {
  "id": "cf-exposed-credentials-ruleset-removed",
  "group": "Managed rules and OWASP",
  "title": "Deprecated Exposed Credentials Check ruleset is not deployed",
  "why": "Exposed credentials check is deprecated; Cloudflare recommends leaked credentials detection instead and turning the old ruleset off to cut latency.",
  "source": "https://developers.cloudflare.com/waf/managed-rules/reference/exposed-credentials-check/",
  "check": {
   "rule": {
    "phase": "http_request_firewall_managed",
    "expect": "absent",
    "conditions": [
     {
      "field": "action_parameters.id",
      "match": "equals",
      "value": "c2e184081120413c86c3ab7e14069605"
     }
    ]
   }
  }
 },
 {
  "id": "cf-attack-score-rule-present",
  "group": "Attack score and leaked credentials",
  "title": "An enabled custom rule blocks or challenges by WAF attack score",
  "why": "Cloudflare recommends blocking cf.waf.score le 20 (Enterprise) or cf.waf.score.class eq attack (Business).",
  "source": "https://developers.cloudflare.com/waf/detections/attack-score/",
  "check": {
   "rule": {
    "phase": "http_request_firewall_custom",
    "expect": "present",
    "conditions": [
     {
      "field": "expression",
      "match": "contains",
      "value": "cf.waf.score"
     },
     {
      "field": "action",
      "match": "one_of",
      "value": "block,managed_challenge,challenge,js_challenge"
     },
     {
      "field": "enabled",
      "match": "equals",
      "value": "true"
     }
    ]
   }
  }
 },
 {
  "id": "cf-attack-score-rule-not-log",
  "group": "Attack score and leaked credentials",
  "title": "Attack score custom rules are not left on Log",
  "why": "Cloudflare says to move from Log to Managed Challenge or Block after a few days of monitoring.",
  "source": "https://developers.cloudflare.com/waf/detections/attack-score/",
  "check": {
   "rule": {
    "phase": "http_request_firewall_custom",
    "expect": "absent",
    "conditions": [
     {
      "field": "expression",
      "match": "contains",
      "value": "cf.waf.score"
     },
     {
      "field": "action",
      "match": "equals",
      "value": "log"
     }
    ]
   }
  }
 },
 {
  "id": "cf-attack-score-no-likely-attack-block",
  "group": "Attack score and leaked credentials",
  "title": "No rule blocks the whole likely_attack class",
  "why": "Cloudflare does not recommend blocking every score below 50, because the likely-attack range can include false positives.",
  "source": "https://developers.cloudflare.com/waf/detections/attack-score/",
  "check": {
   "rule": {
    "phase": "http_request_firewall_custom",
    "expect": "absent",
    "conditions": [
     {
      "field": "expression",
      "match": "contains",
      "value": "likely_attack"
     },
     {
      "field": "action",
      "match": "equals",
      "value": "block"
     }
    ]
   }
  }
 },
 {
  "id": "cf-leaked-credentials-rule-present",
  "group": "Attack score and leaked credentials",
  "title": "An enabled custom rule challenges requests with leaked credentials",
  "why": "Cloudflare's recommended mitigation for paid plans is cf.waf.credential_check.username_and_password_leaked with Managed Challenge.",
  "source": "https://developers.cloudflare.com/waf/detections/leaked-credentials/get-started/",
  "check": {
   "rule": {
    "phase": "http_request_firewall_custom",
    "expect": "present",
    "conditions": [
     {
      "field": "expression",
      "match": "contains",
      "value": "cf.waf.credential_check"
     },
     {
      "field": "action",
      "match": "one_of",
      "value": "managed_challenge,block,challenge,js_challenge"
     },
     {
      "field": "enabled",
      "match": "equals",
      "value": "true"
     }
    ]
   }
  }
 },
 {
  "id": "cf-leaked-credentials-rule-not-log",
  "group": "Attack score and leaked credentials",
  "title": "Leaked credentials custom rules are not left on Log",
  "why": "Detection does nothing by itself; a rule must challenge or block requests with compromised credentials.",
  "source": "https://developers.cloudflare.com/waf/detections/leaked-credentials/",
  "check": {
   "rule": {
    "phase": "http_request_firewall_custom",
    "expect": "absent",
    "conditions": [
     {
      "field": "expression",
      "match": "contains",
      "value": "cf.waf.credential_check"
     },
     {
      "field": "action",
      "match": "equals",
      "value": "log"
     }
    ]
   }
  }
 },
 {
  "id": "cf-leaked-credentials-ratelimit",
  "group": "Attack score and leaked credentials",
  "title": "A rate limiting rule limits logins that use leaked credentials",
  "why": "Cloudflare's example limits requests matching cf.waf.credential_check.username_and_password_leaked to 5 per minute per IP (the suggested template on Free plans).",
  "source": "https://developers.cloudflare.com/waf/detections/leaked-credentials/examples/",
  "check": {
   "rule": {
    "phase": "http_ratelimit",
    "expect": "present",
    "conditions": [
     {
      "field": "expression",
      "match": "contains",
      "value": "cf.waf.credential_check"
     },
     {
      "field": "ratelimit.period",
      "match": "at_most",
      "value": "60"
     },
     {
      "field": "ratelimit.requests_per_period",
      "match": "at_most",
      "value": "5"
     }
    ]
   }
  }
 },
 {
  "id": "cf-malicious-upload-block",
  "group": "Attack score and leaked credentials",
  "title": "A custom rule blocks uploads flagged as malicious",
  "why": "Content scanning does not block on its own; Cloudflare's example blocks cf.waf.content_scan.has_malicious_obj.",
  "source": "https://developers.cloudflare.com/waf/detections/malicious-uploads/example-rules/",
  "check": {
   "rule": {
    "phase": "http_request_firewall_custom",
    "expect": "present",
    "conditions": [
     {
      "field": "expression",
      "match": "contains",
      "value": "cf.waf.content_scan.has_malicious_obj"
     },
     {
      "field": "action",
      "match": "equals",
      "value": "block"
     },
     {
      "field": "enabled",
      "match": "equals",
      "value": "true"
     }
    ]
   }
  }
 },
 {
  "id": "cf-upload-over-scan-limit-block",
  "group": "Attack score and leaked credentials",
  "title": "A custom rule blocks uploads above the 50 MB scan limit",
  "why": "Files over the scan limit are not fully scanned; Cloudflare's example blocks obj_sizes >= 52428800.",
  "source": "https://developers.cloudflare.com/waf/detections/malicious-uploads/example-rules/",
  "check": {
   "rule": {
    "phase": "http_request_firewall_custom",
    "expect": "present",
    "conditions": [
     {
      "field": "expression",
      "match": "contains",
      "value": "52428800"
     },
     {
      "field": "action",
      "match": "equals",
      "value": "block"
     }
    ]
   }
  }
 },
 {
  "id": "cf-malicious-upload-not-log",
  "group": "Attack score and leaked credentials",
  "title": "Malicious-upload rules are not left on Log",
  "why": "Logging uploads (has_obj) is fine for visibility, but a rule on has_malicious_obj should block.",
  "source": "https://developers.cloudflare.com/waf/detections/malicious-uploads/",
  "check": {
   "rule": {
    "phase": "http_request_firewall_custom",
    "expect": "absent",
    "conditions": [
     {
      "field": "expression",
      "match": "contains",
      "value": "cf.waf.content_scan.has_malicious_obj"
     },
     {
      "field": "action",
      "match": "equals",
      "value": "log"
     }
    ]
   }
  }
 },
 {
  "id": "cf-bot-score-rule-present",
  "group": "Bots",
  "title": "An enabled custom rule acts on low bot scores (Bot Management)",
  "why": "Cloudflare's templates challenge or block definite (score 1) and likely (2–29) bots.",
  "source": "https://developers.cloudflare.com/bots/get-started/bot-management/",
  "check": {
   "rule": {
    "phase": "http_request_firewall_custom",
    "expect": "present",
    "conditions": [
     {
      "field": "expression",
      "match": "contains",
      "value": "cf.bot_management.score"
     },
     {
      "field": "action",
      "match": "one_of",
      "value": "block,managed_challenge,challenge,js_challenge"
     },
     {
      "field": "enabled",
      "match": "equals",
      "value": "true"
     }
    ]
   }
  }
 },
 {
  "id": "cf-bot-rule-excludes-verified",
  "group": "Bots",
  "title": "Bot score rules exclude verified bots",
  "why": "Cloudflare's Definite Bots and Likely Bots templates add 'not cf.bot_management.verified_bot' so good bots such as search engines are not hit.",
  "source": "https://developers.cloudflare.com/bots/get-started/bot-management/",
  "check": {
   "rule": {
    "phase": "http_request_firewall_custom",
    "expect": "present",
    "conditions": [
     {
      "field": "expression",
      "match": "contains",
      "value": "cf.bot_management.score"
     },
     {
      "field": "expression",
      "match": "contains",
      "value": "cf.bot_management.verified_bot"
     }
    ]
   }
  }
 },
 {
  "id": "cf-bot-rule-excludes-static",
  "group": "Bots",
  "title": "Bot score rules exclude static resources",
  "why": "Cloudflare's templates add 'not cf.bot_management.static_resource', because blocking static files can break good bots such as mail clients.",
  "source": "https://developers.cloudflare.com/bots/reference/static-resources/",
  "check": {
   "rule": {
    "phase": "http_request_firewall_custom",
    "expect": "present",
    "conditions": [
     {
      "field": "expression",
      "match": "contains",
      "value": "cf.bot_management.score"
     },
     {
      "field": "expression",
      "match": "contains",
      "value": "cf.bot_management.static_resource"
     }
    ]
   }
  }
 },
 {
  "id": "cf-bot-rule-not-log",
  "group": "Bots",
  "title": "Bot score rules are not left on Log",
  "why": "Cloudflare's guidance is to act on low-scoring traffic through custom rules, which Log does not do.",
  "source": "https://developers.cloudflare.com/bots/get-started/bot-management/",
  "check": {
   "rule": {
    "phase": "http_request_firewall_custom",
    "expect": "absent",
    "conditions": [
     {
      "field": "expression",
      "match": "contains",
      "value": "cf.bot_management.score"
     },
     {
      "field": "action",
      "match": "equals",
      "value": "log"
     }
    ]
   }
  }
 },
 {
  "id": "cf-bot-ratelimit-low-score",
  "group": "Bots",
  "title": "A rate limit rule throttles low bot-score traffic on sensitive actions",
  "why": "Cloudflare's best-practice examples rate limit cf.bot_management.score lt 30 (Managed Challenge) and lt 10 (Block) on sensitive operations.",
  "source": "https://developers.cloudflare.com/waf/rate-limiting-rules/best-practices/",
  "check": {
   "rule": {
    "phase": "http_ratelimit",
    "expect": "present",
    "conditions": [
     {
      "field": "expression",
      "match": "contains",
      "value": "cf.bot_management.score"
     },
     {
      "field": "action",
      "match": "one_of",
      "value": "block,managed_challenge"
     }
    ]
   }
  }
 },
 {
  "id": "cf-ratelimit-any-rule",
  "group": "Rate limiting",
  "title": "At least one enabled rate limiting rule exists",
  "why": "Cloudflare recommends rate limiting rules to limit traffic to what is known to be normal usage.",
  "source": "https://developers.cloudflare.com/ddos-protection/best-practices/proactive-defense/",
  "check": {
   "rule": {
    "phase": "http_ratelimit",
    "expect": "present",
    "conditions": [
     {
      "field": "enabled",
      "match": "equals",
      "value": "true"
     }
    ]
   }
  }
 },
 {
  "id": "cf-ratelimit-login-present",
  "group": "Rate limiting",
  "title": "A rate limit rule protects the login endpoint",
  "why": "Cloudflare's credential-stuffing guidance puts rate limits on POST /login.",
  "source": "https://developers.cloudflare.com/waf/rate-limiting-rules/best-practices/",
  "check": {
   "rule": {
    "phase": "http_ratelimit",
    "expect": "present",
    "conditions": [
     {
      "field": "expression",
      "match": "contains",
      "value": "login"
     },
     {
      "field": "action",
      "match": "one_of",
      "value": "managed_challenge,block,challenge,js_challenge"
     }
    ]
   }
  }
 },
 {
  "id": "cf-ratelimit-login-per-ip",
  "group": "Rate limiting",
  "title": "Login rate limit counts per client IP",
  "why": "Cloudflare's credential-stuffing examples count by IP (IP with NAT support, cf.unique_visitor_id, is the alternative when many users share an IP).",
  "source": "https://developers.cloudflare.com/waf/rate-limiting-rules/parameters/",
  "check": {
   "rule": {
    "phase": "http_ratelimit",
    "expect": "present",
    "conditions": [
     {
      "field": "expression",
      "match": "contains",
      "value": "login"
     },
     {
      "field": "ratelimit.characteristics",
      "match": "contains",
      "value": "ip.src"
     }
    ]
   }
  }
 },
 {
  "id": "cf-ratelimit-login-failed-responses",
  "group": "Rate limiting",
  "title": "Login rate limit counts only failed attempts (401/403)",
  "why": "Cloudflare's example counting expression adds http.response.code in {401 403} so successful logins are not counted (Business plan and above).",
  "source": "https://developers.cloudflare.com/waf/rate-limiting-rules/best-practices/",
  "check": {
   "rule": {
    "phase": "http_ratelimit",
    "expect": "present",
    "conditions": [
     {
      "field": "expression",
      "match": "contains",
      "value": "login"
     },
     {
      "field": "ratelimit.counting_expression",
      "match": "contains",
      "value": "http.response.code"
     }
    ]
   }
  }
 },
 {
  "id": "cf-ratelimit-login-tight-threshold",
  "group": "Rate limiting",
  "title": "Login rate limit allows no more than 10 requests per period of up to 10 minutes",
  "why": "Cloudflare's login examples use 4 per 1 minute and 10 per 10 minutes.",
  "source": "https://developers.cloudflare.com/waf/rate-limiting-rules/best-practices/",
  "check": {
   "rule": {
    "phase": "http_ratelimit",
    "expect": "present",
    "conditions": [
     {
      "field": "expression",
      "match": "contains",
      "value": "login"
     },
     {
      "field": "ratelimit.requests_per_period",
      "match": "at_most",
      "value": "10"
     },
     {
      "field": "ratelimit.period",
      "match": "at_most",
      "value": "600"
     }
    ]
   }
  }
 },
 {
  "id": "cf-ratelimit-login-long-block",
  "group": "Rate limiting",
  "title": "A long-window login abuse rule blocks for 1 day",
  "why": "Cloudflare's credential-stuffing rule #3 counts failed logins at 20 per hour and blocks the IP for one day (86400 s).",
  "source": "https://developers.cloudflare.com/waf/rate-limiting-rules/best-practices/",
  "check": {
   "rule": {
    "phase": "http_ratelimit",
    "expect": "present",
    "conditions": [
     {
      "field": "ratelimit.counting_expression",
      "match": "contains",
      "value": "login"
     },
     {
      "field": "ratelimit.period",
      "match": "equals",
      "value": "3600"
     },
     {
      "field": "ratelimit.mitigation_timeout",
      "match": "equals",
      "value": "86400"
     },
     {
      "field": "action",
      "match": "equals",
      "value": "block"
     }
    ]
   }
  }
 },
 {
  "id": "cf-ratelimit-4xx-scanner",
  "group": "Rate limiting",
  "title": "A rate limit rule challenges clients that generate many 403/404 responses",
  "why": "Cloudflare's example counts http.response.code in {403 404} (5 per 3 minutes, Managed Challenge) to catch scanning bots.",
  "source": "https://developers.cloudflare.com/waf/rate-limiting-rules/best-practices/",
  "check": {
   "rule": {
    "phase": "http_ratelimit",
    "expect": "present",
    "conditions": [
     {
      "field": "ratelimit.counting_expression",
      "match": "contains",
      "value": "404"
     },
     {
      "field": "action",
      "match": "one_of",
      "value": "managed_challenge,block"
     }
    ]
   }
  }
 },
 {
  "id": "cf-ratelimit-no-colo-in-expression",
  "group": "Rate limiting",
  "title": "Rate limit expressions do not use cf.colo.id",
  "why": "Cloudflare says not to use the cf.colo.id characteristic as a field in rule expressions; it is added to counting automatically.",
  "source": "https://developers.cloudflare.com/waf/rate-limiting-rules/parameters/",
  "check": {
   "rule": {
    "phase": "http_ratelimit",
    "expect": "absent",
    "conditions": [
     {
      "field": "expression",
      "match": "contains",
      "value": "cf.colo.id"
     }
    ]
   }
  }
 },
 {
  "id": "cf-ratelimit-lists-count-cached",
  "group": "Rate limiting",
  "title": "Rate limits that use custom lists also count cached requests",
  "why": "When the expression uses custom lists, the 'apply to cached assets' option must stay on, which is requests_to_origin = false in the API.",
  "source": "https://developers.cloudflare.com/waf/rate-limiting-rules/parameters/",
  "check": {
   "rule": {
    "phase": "http_ratelimit",
    "expect": "absent",
    "conditions": [
     {
      "field": "expression",
      "match": "contains",
      "value": "$"
     },
     {
      "field": "ratelimit.requests_to_origin",
      "match": "equals",
      "value": "true"
     }
    ]
   }
  }
 },
 {
  "id": "cf-ratelimit-challenge-throttle",
  "group": "Rate limiting",
  "title": "Challenge-action rate limits throttle (mitigation_timeout 0)",
  "why": "On Free, Pro and Business, the API requires mitigation_timeout 0 (throttle requests over the rate) for managed_challenge, js_challenge and challenge.",
  "source": "https://developers.cloudflare.com/waf/rate-limiting-rules/parameters/",
  "check": {
   "rule": {
    "phase": "http_ratelimit",
    "expect": "absent",
    "conditions": [
     {
      "field": "action",
      "match": "one_of",
      "value": "managed_challenge,js_challenge,challenge"
     },
     {
      "field": "ratelimit.mitigation_timeout",
      "match": "not_equals",
      "value": "0"
     }
    ]
   }
  }
 },
 {
  "id": "cf-ddos-not-eoff",
  "group": "DDoS",
  "title": "HTTP DDoS ruleset sensitivity is not Essentially Off",
  "why": "Cloudflare recommends keeping DDoS managed rulesets at the default (High) sensitivity; eoff usually stops even logging.",
  "source": "https://developers.cloudflare.com/ddos-protection/managed-rulesets/http/override-parameters/",
  "check": {
   "rule": {
    "phase": "ddos_l7",
    "expect": "absent",
    "conditions": [
     {
      "field": "action_parameters.id",
      "match": "equals",
      "value": "4d21379b4f9f4bb088e0729962c8b3cf"
     },
     {
      "field": "action_parameters.overrides.sensitivity_level",
      "match": "equals",
      "value": "eoff"
     }
    ]
   }
  }
 },
 {
  "id": "cf-ddos-sensitivity-default",
  "group": "DDoS",
  "title": "HTTP DDoS ruleset sensitivity is not lowered to Medium or Low",
  "why": "Cloudflare's proactive defense guidance is to keep DDoS managed rulesets at default High sensitivity ('default').",
  "source": "https://developers.cloudflare.com/ddos-protection/best-practices/proactive-defense/",
  "check": {
   "rule": {
    "phase": "ddos_l7",
    "expect": "absent",
    "conditions": [
     {
      "field": "action_parameters.id",
      "match": "equals",
      "value": "4d21379b4f9f4bb088e0729962c8b3cf"
     },
     {
      "field": "action_parameters.overrides.sensitivity_level",
      "match": "one_of",
      "value": "medium,low"
     }
    ]
   }
  }
 },
 {
  "id": "cf-ddos-category-not-eoff",
  "group": "DDoS",
  "title": "No HTTP DDoS category is set to Essentially Off",
  "why": "A category override at eoff stops mitigation for every rule with that tag.",
  "source": "https://developers.cloudflare.com/ddos-protection/managed-rulesets/http/override-parameters/",
  "check": {
   "rule": {
    "phase": "ddos_l7",
    "expect": "absent",
    "conditions": [
     {
      "field": "action_parameters.id",
      "match": "equals",
      "value": "4d21379b4f9f4bb088e0729962c8b3cf"
     },
     {
      "field": "action_parameters.overrides.categories[*].sensitivity_level",
      "match": "equals",
      "value": "eoff"
     }
    ]
   }
  }
 },
 {
  "id": "cf-ddos-rule-not-eoff",
  "group": "DDoS",
  "title": "No individual HTTP DDoS rule is set to Essentially Off",
  "why": "A rule override at eoff stops mitigation for that attack signature.",
  "source": "https://developers.cloudflare.com/ddos-protection/managed-rulesets/http/override-parameters/",
  "check": {
   "rule": {
    "phase": "ddos_l7",
    "expect": "absent",
    "conditions": [
     {
      "field": "action_parameters.id",
      "match": "equals",
      "value": "4d21379b4f9f4bb088e0729962c8b3cf"
     },
     {
      "field": "action_parameters.overrides.rules[*].sensitivity_level",
      "match": "equals",
      "value": "eoff"
     }
    ]
   }
  }
 },
 {
  "id": "cf-ddos-not-ruleset-log",
  "group": "DDoS",
  "title": "HTTP DDoS ruleset is not overridden to Log",
  "why": "Log (Enterprise with Advanced DDoS only) is meant for validating a rule before a stronger action, not as a permanent setting; the default is the mitigation action.",
  "source": "https://developers.cloudflare.com/ddos-protection/managed-rulesets/http/override-parameters/",
  "check": {
   "rule": {
    "phase": "ddos_l7",
    "expect": "absent",
    "conditions": [
     {
      "field": "action_parameters.id",
      "match": "equals",
      "value": "4d21379b4f9f4bb088e0729962c8b3cf"
     },
     {
      "field": "action_parameters.overrides.action",
      "match": "equals",
      "value": "log"
     }
    ]
   }
  }
 },
 {
  "id": "cf-ddos-not-disabled",
  "group": "DDoS",
  "title": "HTTP DDoS ruleset rules are not disabled by override",
  "why": "Cloudflare recommends default DDoS settings; disabling the ruleset removes L7 DDoS mitigation.",
  "source": "https://developers.cloudflare.com/ddos-protection/best-practices/proactive-defense/",
  "check": {
   "rule": {
    "phase": "ddos_l7",
    "expect": "absent",
    "conditions": [
     {
      "field": "action_parameters.id",
      "match": "equals",
      "value": "4d21379b4f9f4bb088e0729962c8b3cf"
     },
     {
      "field": "action_parameters.overrides.enabled",
      "match": "equals",
      "value": "false"
     }
    ]
   }
  }
 },
 {
  "id": "cf-ddos-origin-protect-enabled",
  "group": "DDoS",
  "title": "Adaptive Origin Protect DDoS rule is not disabled",
  "why": "Rule dd42da7b... (available on all plans) mitigates request floods that cause unusually high origin error rates.",
  "source": "https://developers.cloudflare.com/ddos-protection/managed-rulesets/http/",
  "check": {
   "rule": {
    "phase": "ddos_l7",
    "expect": "absent",
    "conditions": [
     {
      "field": "action_parameters.overrides.rules[*].id",
      "match": "equals",
      "value": "dd42da7baabe4e518eaf11c393596a9d"
     },
     {
      "field": "action_parameters.overrides.rules[*].enabled",
      "match": "equals",
      "value": "false"
     }
    ]
   }
  }
 },
 {
  "id": "cf-cache-rule-eligible",
  "group": "Cache and CDN",
  "title": "A cache rule marks static content as eligible for cache",
  "why": "Cloudflare recommends caching as much as possible and creating a Cache Rule for static content returning DYNAMIC.",
  "source": "https://developers.cloudflare.com/speed/troubleshooting/slow-website/",
  "check": {
   "rule": {
    "phase": "http_request_cache_settings",
    "expect": "present",
    "conditions": [
     {
      "field": "action",
      "match": "equals",
      "value": "set_cache_settings"
     },
     {
      "field": "action_parameters.cache",
      "match": "equals",
      "value": "true"
     }
    ]
   }
  }
 },
 {
  "id": "cf-cache-deception-armor",
  "group": "Cache and CDN",
  "title": "Cache Deception Armor is on in a cache rule",
  "why": "It caches a response only when the URL extension matches the Content-Type, which protects users from Web Cache Deception.",
  "source": "https://developers.cloudflare.com/cache/cache-security/cache-deception-armor/",
  "check": {
   "rule": {
    "phase": "http_request_cache_settings",
    "expect": "present",
    "conditions": [
     {
      "field": "action_parameters.cache",
      "match": "equals",
      "value": "true"
     },
     {
      "field": "action_parameters.cache_key.cache_deception_armor",
      "match": "equals",
      "value": "true"
     }
    ]
   }
  }
 },
 {
  "id": "cf-cache-edge-ttl-set",
  "group": "Cache and CDN",
  "title": "Cacheable cache rules set an Edge TTL mode",
  "why": "Cloudflare advises setting appropriate Edge TTLs on cache rules and overriding origin no-store/private for static content.",
  "source": "https://developers.cloudflare.com/speed/troubleshooting/slow-website/",
  "check": {
   "rule": {
    "phase": "http_request_cache_settings",
    "expect": "present",
    "conditions": [
     {
      "field": "action_parameters.cache",
      "match": "equals",
      "value": "true"
     },
     {
      "field": "action_parameters.edge_ttl.mode",
      "match": "one_of",
      "value": "override_origin,respect_origin"
     }
    ]
   }
  }
 },
 {
  "id": "cf-cache-ignore-query-string",
  "group": "Cache and CDN",
  "title": "A cache rule excludes the query string from the cache key for static assets",
  "why": "Cloudflare's DDoS guidance is to exclude the query string so cache-busting attack requests with random query strings are served from cache.",
  "source": "https://developers.cloudflare.com/ddos-protection/best-practices/proactive-defense/",
  "check": {
   "rule": {
    "phase": "http_request_cache_settings",
    "expect": "present",
    "conditions": [
     {
      "field": "action_parameters.cache",
      "match": "equals",
      "value": "true"
     },
     {
      "field": "action_parameters.cache_key.custom_key.query_string.exclude.all",
      "match": "equals",
      "value": "true"
     }
    ]
   }
  }
 },
 {
  "id": "cf-query-string-sort-off",
  "group": "Cache and CDN",
  "title": "Zone-wide Query String Sort is off",
  "why": "Cloudflare says to leave it off (the default) unless parameter order never matters, and to enable it per URL with cache rules instead.",
  "source": "https://developers.cloudflare.com/cache/advanced-configuration/query-string-sort/",
  "check": {
   "setting": {
    "id": "sort_query_string_for_cache",
    "match": "equals",
    "value": "off"
   }
  }
 },
 {
  "id": "cf-http2-on",
  "group": "Speed and protocols",
  "title": "HTTP/2 is on",
  "why": "HTTP/2 is on by default and is listed among Cloudflare's recommended speed optimizations (multiplexing).",
  "source": "https://developers.cloudflare.com/speed/optimization/protocol/http2/",
  "check": {
   "setting": {
    "id": "http2",
    "match": "equals",
    "value": "on"
   }
  }
 },
 {
  "id": "cf-http3-on",
  "group": "Speed and protocols",
  "title": "HTTP/3 (QUIC) is on",
  "why": "Cloudflare's slow-website guide lists HTTP/2 and HTTP/3 as recommended optimizations.",
  "source": "https://developers.cloudflare.com/speed/troubleshooting/slow-website/",
  "check": {
   "setting": {
    "id": "http3",
    "match": "equals",
    "value": "on"
   }
  }
 },
 {
  "id": "cf-early-hints-on",
  "group": "Speed and protocols",
  "title": "Early Hints is on",
  "why": "Cloudflare's slow-website guide recommends Early Hints to preload critical resources.",
  "source": "https://developers.cloudflare.com/speed/troubleshooting/slow-website/",
  "check": {
   "setting": {
    "id": "early_hints",
    "match": "equals",
    "value": "on"
   }
  }
 },
 {
  "id": "cf-brotli-on",
  "group": "Speed and protocols",
  "title": "Brotli compression is on",
  "why": "Cloudflare's slow-website guide recommends Brotli for faster transfers.",
  "source": "https://developers.cloudflare.com/speed/troubleshooting/slow-website/",
  "check": {
   "setting": {
    "id": "brotli",
    "match": "equals",
    "value": "on"
   }
  }
 },
 {
  "id": "cf-header-x-content-type-options",
  "group": "Security headers",
  "title": "Responses set X-Content-Type-Options: nosniff",
  "why": "Both Cloudflare's 'Add security headers' managed transform and its security-headers example set nosniff.",
  "source": "https://developers.cloudflare.com/rules/transform/managed-transforms/reference/",
  "check": {
   "rule": {
    "phase": "http_response_headers_transform",
    "expect": "present",
    "conditions": [
     {
      "field": "action",
      "match": "equals",
      "value": "rewrite"
     },
     {
      "field": "action_parameters.headers.X-Content-Type-Options.value",
      "match": "equals",
      "value": "nosniff"
     }
    ]
   }
  }
 },
 {
  "id": "cf-header-x-frame-options",
  "group": "Security headers",
  "title": "Responses set X-Frame-Options to SAMEORIGIN or DENY",
  "why": "Cloudflare's managed security headers transform uses SAMEORIGIN, which protects against clickjacking.",
  "source": "https://developers.cloudflare.com/rules/transform/managed-transforms/reference/",
  "check": {
   "rule": {
    "phase": "http_response_headers_transform",
    "expect": "present",
    "conditions": [
     {
      "field": "action_parameters.headers.X-Frame-Options.value",
      "match": "one_of",
      "value": "SAMEORIGIN,DENY"
     }
    ]
   }
  }
 },
 {
  "id": "cf-header-referrer-policy",
  "group": "Security headers",
  "title": "Responses set a restrictive Referrer-Policy",
  "why": "Cloudflare's managed transform uses same-origin and its security-headers example uses strict-origin-when-cross-origin.",
  "source": "https://developers.cloudflare.com/rules/snippets/examples/security-headers/",
  "check": {
   "rule": {
    "phase": "http_response_headers_transform",
    "expect": "present",
    "conditions": [
     {
      "field": "action_parameters.headers.Referrer-Policy.value",
      "match": "one_of",
      "value": "same-origin,strict-origin-when-cross-origin,no-referrer,strict-origin"
     }
    ]
   }
  }
 },
 {
  "id": "cf-header-remove-x-powered-by",
  "group": "Security headers",
  "title": "X-Powered-By response header is removed",
  "why": "Cloudflare provides a managed transform and a security-headers example that strip X-Powered-By so the server stack is not revealed.",
  "source": "https://developers.cloudflare.com/rules/snippets/examples/security-headers/",
  "check": {
   "rule": {
    "phase": "http_response_headers_transform",
    "expect": "present",
    "conditions": [
     {
      "field": "action_parameters.headers.X-Powered-By.operation",
      "match": "equals",
      "value": "remove"
     }
    ]
   }
  }
 },
 {
  "id": "cf-header-remove-x-aspnet-version",
  "group": "Security headers",
  "title": "X-AspNet-Version response header is removed",
  "why": "Cloudflare's security-headers example deletes X-AspNet-Version so the framework version is not revealed.",
  "source": "https://developers.cloudflare.com/rules/snippets/examples/security-headers/",
  "check": {
   "rule": {
    "phase": "http_response_headers_transform",
    "expect": "present",
    "conditions": [
     {
      "field": "action_parameters.headers.X-AspNet-Version.operation",
      "match": "equals",
      "value": "remove"
     }
    ]
   }
  }
 },
 {
  "id": "cf-dnssec-active",
  "group": "DNS",
  "title": "DNSSEC is active",
  "why": "With DNSSEC, Cloudflare signs the zone and generates a DS record; it protects the zone only after that DS record is added at the registrar.",
  "source": "https://developers.cloudflare.com/dns/dnssec/",
  "check": {
   "setting": {
    "id": "dnssec",
    "match": "equals",
    "value": "active"
   }
  }
 }
];
