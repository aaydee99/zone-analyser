// The security policy rule set (POL custom rules, RL rate limiting rules) as granular template checks:
// for each rule, that it exists (found by its match expression, wherever it sits in the phase), that its
// action is the target action, that Managed Challenge rules exclude API paths, and for rate limiting
// rules the threshold, what it counts by, origin-only counting, throttle mode and the counting
// expression, each a check of its own. Host conditions (http.host in {...}) are left out: zones are
// checked one by one. Pure: shared by the page and the tests.

import type { CheckWhen, TemplateItem } from './zone-index';

export type PolicyTarget = 'challenge_then_block' | 'challenge' | 'log' | 'block_after_review';
export interface PolicyRule { id: string; category: 'THREATINTEL' | 'DETIDS' | 'BOTMGT' | 'WAFAS'; phase: 1 | 2 | 3 | 4; title: string; target: PolicyTarget; targetText: string; expression?: string; detectionIds?: string }
export interface RateRule {
  id: string; title: string; requests: number; period: number; natAware: boolean;
  /** The match expression (without host conditions); "true" for every request; absent when it is only the zone's hostnames. */
  expression?: string;
  /** A counting expression other than the match expression. */
  counting?: string;
  /** API rules: Block with throttling (API clients cannot solve a challenge). */
  block?: boolean;
}

const T: Record<PolicyTarget, string> = {
  challenge_then_block: 'Managed Challenge, then Block',
  challenge: 'Managed Challenge (API paths and hosts excluded)',
  log: 'Remain in Log',
  block_after_review: 'Block after review, with exceptions',
};
const pol = (id: string, category: PolicyRule['category'], phase: PolicyRule['phase'], title: string, target: PolicyTarget, more: { expression?: string; detectionIds?: string; targetText?: string }): PolicyRule =>
  ({ id, category, phase, title, target, targetText: more.targetText ?? T[target], ...(more.expression ? { expression: more.expression } : {}), ...(more.detectionIds ? { detectionIds: more.detectionIds } : {}) });

export const POLICY_RULES: PolicyRule[] = [
  // Phase 1
  pol('POL-1005', 'THREATINTEL', 1, 'WAF ATTACK SCORE 1-5', 'challenge_then_block', { expression: 'cf.waf.score ge 1 and cf.waf.score lt 6' }),
  pol('POL-1010', 'THREATINTEL', 1, 'CF ANONYMIZER', 'challenge', { expression: 'ip.src in $cf.anonymizer' }),
  pol('POL-1011', 'THREATINTEL', 1, 'CF BOTNET COMMAND AND CONTROL CENTER', 'challenge', { expression: 'ip.src in $cf.botnetcc' }),
  pol('POL-1012', 'THREATINTEL', 1, 'CF MALWARE', 'challenge', { expression: 'ip.src in $cf.malware' }),
  pol('POL-1013', 'THREATINTEL', 1, 'CF OPEN PROXIES', 'challenge', { expression: 'ip.src in $cf.open_proxies' }),
  pol('POL-1014', 'THREATINTEL', 1, 'CF VPN', 'log', { expression: 'ip.src in $cf.vpn', targetText: 'Remain in Log, review for removal' }),
  // Phase 2
  pol('POL-8007', 'DETIDS', 2, 'DoS TOOL', 'challenge', { detectionIds: '33554433 33554927 33564223 33564225 154357709 157468811 158072645 166185009' }),
  pol('POL-8008', 'DETIDS', 2, 'SNEAKER-BOT', 'challenge', { detectionIds: '33554434 33554447 33554475 33554488 33554492 33554497 33554499 33554500 33554503 33554509 33554510 33554518 33554519 33554525 33554531 33554551 33554556 33554564 33554565 33554567 33554572 33554607 33554624 33554657 33554672 33554676 33554700 33554702 33554704 33554705 33554706 33554714 33554715 33554718 33554719 33554721 33554724 33554725 33554726 33554727 33554728 33554729 33554730 33554732 33554733 33554734 33554735 33554739 33554740 33554741 33554744 33554745 33554746 33554747 33554748 33554749 33554750 33554751 33554753 33554754 33554755 33554757 33554759 33554760 33554761 33554762 33554763 33554764 33554766 33554770 33554771 33554772 33554773 33554777 33554778 33554779 33554780 33554781 33554783 33554789 33554790 33554791 33554798 33554810 33554834 33554835 33554841 33554842 33554849 33554872 33554873 33554877 33554879 33564163 33564165 33564167 33564169 33564171 33564173 33564175 33564178' }),
  pol('POL-8009', 'DETIDS', 2, 'JAVA-BOT', 'challenge', { detectionIds: '33554442 33554467 33554470 33554508 33554545 33554546 33554547 33554548 33554579 33554588 33554590 33554591 33554634 33554671 33554708 33554717 33554812 33554813 33554814 33554815 33554816 33554818 33554819 33554820 33554821 33554824 33554826 33554827 33554828 33554829 33554830 33554836 33554837 33554838 33554839 33554845 33554899 33554919 33554936 33558685 33563794 33563903 33563905 33564063 33564065 33564161 33564207 153208682 162007718 163305579' }),
  pol('POL-8010', 'DETIDS', 2, 'cURL', 'challenge', { detectionIds: '33554448 33554469 33554512 33554532 33554533 33554534 33554535 33554536 33554537 33554538 33554542 33554544 33554563 33554568 33554571 33554574 33554575 33554576 33554605 33554633 33554636 33554638 33554639 33554645 33554673 33554701 33554738 33554774 33554806 33554817 33554844 33554871 33554928 33563685 33563720 33563798 33564061 33564155 33564157 33564159 162073760 164610470' }),
  pol('POL-8011', 'DETIDS', 2, 'HEADLESS BROWSER UA', 'challenge', { detectionIds: '33554457 33554458 33554528 33558715 33563965' }),
  pol('POL-8012', 'DETIDS', 2, 'VULNERABILITY SCANNING', 'challenge', { detectionIds: '33554805 33554866 33554867 33554882 33563907 33563920 33564200 33564202 33564215 154330752' }),
  pol('POL-8013', 'DETIDS', 2, 'NODE.js BOT', 'log', { targetText: 'Remain in Log pending review', detectionIds: '33554454 33554494 33554526 33554529 33554555 33554578 33554580 33554595 33554606 33554628 33554629 33554630 33554640 33554641 33554652 33554660 33554662 33554670 33554776 33554802 33554807 33554823 33555965 33558687 33558707 33558717 33564147 122223833 152295520' }),
  pol('POL-8014', 'DETIDS', 2, 'SEO BOTS', 'challenge', { detectionIds: '33554459 33554460 33554461 33554463 33554584 33563839 33563865 118883123 122426128 125128007 125404561 126282788 129612877 132580853' }),
  pol('POL-8015', 'DETIDS', 2, 'ABNORMAL/BROWSER REQUESTS', 'log', { targetText: 'Remain in Log, review for removal', detectionIds: '33554472 33554473 33554550 33554918 151571662' }),
  pol('POL-8016', 'DETIDS', 2, 'KNOWN TLS SIGNATURE (part 1)', 'log', { targetText: 'Remain in Log, review for removal', detectionIds: '33554433 33554434 33554436 33554441 33554442 33554448 33554450 33554471 33554474 33554475 33554476 33554477 33554478 33554479 33554480 33554481 33554482 33554484 33554485 33554486 33554487 33554488 33554489 33554492 33554493 33554494 33554495 33554496 33554497 33554498 33554499 33554500 33554501 33554505 33554506 33554507 33554508 33554509 33554510 33554511 33554512 33554513 33554514 33554515 33554516 33554517 33554518 33554519 33554520 33554523 33554524 33554525 33554526 33554527 33554529 33554530 33554531 33554532 33554533 33554534 33554535 33554536 33554537 33554538 33554542 33554543 33554544 33554545 33554546 33554547 33554548 33554549 33554551 33554553 33554554 33554555 33554556 33554557 33554558 33554561 33554562 33554563 33554564 33554565 33554566 33554567 33554568 33554569 33554570 33554572 33554574 33554575 33554576 33554579 33554580 33554582 33554588 33554589 33554590 33554591 33554595 33554596 33554597 33554598 33554599 33554600 33554602 33554603 33554604 33554605 33554607 33554608 33554609 33554610 33554612 33554613 33554614 33554615 33554616 33554617 33554621 33554622 33554623 33554624 33554625 33554626 33554627 33554628 33554629 33554630 33554631 33554632 33554633 33554634 33554635 33554636 33554637 33554638 33554639 33554640 33554641 33554642 33554643 33554644 33554645 33554646 33554647 33554648 33554649 33554650 33554652 33554653 33554654 33554655 33554656 33554657 33554658 33554659 33554660 33554661 33554662 33554663 33554665 33554666 33554669 33554670 33554671 33554673 33554675 33554676 33554677 33554678 33554679 33554680 33554684 33554685 33554687 33554688 33554689 33554690 33554691 33554692 33554693 33554694 33554695 33554696 33554697 33554698 33554699 33554700 33554701 33554702 33554703 33554704 33554706 33554707 33554708 33554709 33554710 33554711 33554712 33554713 33554714 33554715 33554716 33554717 33554718 33554720 33554721 33554723 33554724 33554725 33554731 33554732 33554733 33554734 33554735 33554736 33554738 33554739 33554740 33554741 33554742 33554743 33554744 33554745 33554747 33554748 33554749 33554750 33554752 33554753 33554754 33554755 33554757 33554759 33554760 33554761 33554762 33554763 33554764 33554765 33554766 33554767 33554768 33554769 33554770 33554771 33554772 33554773 33554774 33554775 33554776 33554777 33554778 33554779 33554781 33554783 33554786 33554787 33554788 33554789 33554790 33554791' }),
  pol('POL-8017', 'DETIDS', 2, 'KNOWN TLS SIGNATURE (part 2)', 'log', { targetText: 'Remain in Log pending review', detectionIds: '33554792 33554793 33554794 33554796 33554797 33554798 33554801 33554802 33554803 33554804 33554805 33554806 33554807 33554808 33554809 33554810 33554811 33554812 33554813 33554814 33554815 33554816 33554818 33554819 33554820 33554821 33554822 33554823 33554824 33554826 33554827 33554828 33554829 33554830 33554831 33554832 33554833 33554834 33554835 33554836 33554837 33554838 33554839 33554841 33554842 33554843 33554844 33554845 33554846 33554847 33554848 33554849 33554850 33554851 33554853 33554854 33554856 33554857 33554858 33554859 33554860 33554861 33554862 33554863 33554864 33554865 33554866 33554867 33554868 33554869 33554871 33554872 33554873 33554874 33554875 33554876 33554877 33554879 33554881 33554882 33554884 33554897 33554898 33554899 33554901 33554902 33554903 33554905 33554907 33554908 33554911 33554912 33554919 33554925 33554927 33554958 33554975 33555069 33555072 33558213 33560491 33560493 33561985 33563685 33563687 33563790 33563794 33563796 33563831 33563833 33563835 33563901 33563903 33563905 33563914 33563916 33563918 33563922 33563924 33563926 33563928 33563930 33563932 33563965 33563967 33563988 33563990 33563992 33563994 33563996 33563998 33564000 33564002 33564059 33564061 33564063 33564065 33564067 33564069 33564071 33564073 33564075 33564077 33564112 33564114 33564116 33564118 33564120 33564122 33564124 33564126 33564128 33564130 33564137 33564139 33564141 33564143 33564145 33564147 33564149 33564151 33564153 33564155 33564159 33564161 33564163 33564167 33564169 33564171 33564173 33564175 33564178 33564180 33564182 33564184 33564186 33564188 33564190 33564192 33564194 33564196 33564198 33564205 33564207 33564209 33564213 33564219 33564221 33564223 50331649 151051910 151219106 151639714 151790139 151935671 152295520 152888627 153208682 153620563 153813573 154330752 154357709 154920374 155580801 156711944 157468811 157718770 158072645 158082839 159364814 159600225 160352931 160454973 160901235 160956963 161794528 161848281 162007718 162073760 162118083 162444022 162739949 162742967 162961728 163028021 163305579 163338236 163372860 164080006 164127939 164436501 164610470 164625698 165102111 165348117 165918571 166185009 167139453 167338769' }),
  // Phase 3
  pol('POL-8001', 'DETIDS', 3, 'AI CRAWLER CONTROL', 'challenge', { detectionIds: '33563841 33563843 33563845 33563847 33563849 33563851 33563853 33563855 33563857 33563859 33563861 33563863 33563867 33563869 33563875 33563877 33563881 33563883 33563885 33563889 33563891 33563893 33563895 33563897 33563899 33563970 33563972 33563974 33563976 33563978 33563980 33563982 33563984 33563986 33564033 33564035 33564037 33564039 33564041 33564043 33564045 33564047 33564049 33564051 33564053 33564055 33564057 33564132 33564301 33564303 33564305 33564321 33564323 33564369 33564371 151639714 155403339' }),
  pol('POL-8002', 'DETIDS', 3, 'PYTHON BOTS', 'challenge', { detectionIds: '33554443 33554444 33554451 33554453 33554455 33554456 33554471 33554474 33554476 33554477 33554478 33554480 33554481 33554482 33554485 33554489 33554495 33554501 33554505 33554511 33554520 33554554 33554562 33554570 33554577 33554582 33554597 33554602 33554603 33554612 33554614 33554615 33554616 33554617 33554621 33554623 33554625 33554626 33554627 33554637 33554643 33554644 33554646 33554647 33554649 33554650 33554653 33554656 33554659 33554665 33554666 33554674 33554677 33554687 33554689 33554690 33554693 33554696 33554707 33554723 33554752 33554775 33554793 33554796 33554797 33554856 33554857 33554858 33554859 33554860 33554861 33554862 33554863 33554869 33554874 33555060 33555413 33555963 33558213 33558699 33558711 33563831 33563835 33563914 33563916 33563918 33563922 33563924 33563932 33563996 33564059 33564112 33564190 33564205 120080928 122256215 152888627 156711944 159600225 162118083 162444022 165102111' }),
  pol('POL-8003', 'DETIDS', 3, 'GOLANG BOTS', 'challenge', { detectionIds: '33554441 33554452 33554486 33554498 33554506 33554507 33554527 33554566 33554635 33554731 33555516 33555525 33558689 33558691 33558693 33563833 33563837 33563871 33563873 33564141 33564145 33564149 33564151 33564221 33564291 151790139 155580801 160454973 162742967 163338236 164436501 165348117 167139453 167338769' }),
  pol('POL-8004', 'DETIDS', 3, 'RUBY BOTS', 'challenge', { detectionIds: '33554642 33554655 160352931 160956963' }),
  pol('POL-8005', 'DETIDS', 3, 'SCRAPERS BOTS', 'challenge', { detectionIds: '33554436 33554450 33554516 33554530 33554811 33558705 33563722 33563928 33563988 33564217 151219106 151935671 153620563 153813573 154449703 157718770 158082839 159364814 161794528 161848281 162739949 163028021 164080006 164625698 165918571' }),
  pol('POL-8006', 'DETIDS', 3, 'BROWSER IMITATOR', 'challenge', { detectionIds: '33554445 33554446 33554457 33554458 33554473 33554528 33554550 33554885 33554886 33554888 33554889 33554890 33554891 33554892 33554914 33554915 33554916 33554917 33554918 33558715 33563965 151571662' }),
  // Phase 4
  pol('POL-1001', 'THREATINTEL', 4, 'CORPORATE PROXY CHECK', 'log', { expression: 'cf.bot_management.corporate_proxy', targetText: 'Remain in Log pending review' }),
  pol('POL-1002', 'THREATINTEL', 4, 'AI CRAWLER', 'log', { expression: 'cf.verified_bot_category eq "AI Crawler"', targetText: 'Remain in Log pending review' }),
  pol('POL-1003', 'THREATINTEL', 4, 'AI ASSISTANT', 'log', { expression: 'cf.verified_bot_category eq "AI Assistant"', targetText: 'Remain in Log pending review' }),
  pol('POL-1004', 'THREATINTEL', 4, 'AI SEARCH', 'log', { expression: 'cf.verified_bot_category eq "AI Search"', targetText: 'Remain in Log pending review' }),
  pol('POL-1006', 'THREATINTEL', 4, 'BLANK USER AGENT', 'block_after_review', { expression: 'http.user_agent eq ""' }),
  pol('POL-1007', 'THREATINTEL', 4, 'USERNAME AND PASSWORD LEAK', 'challenge', { expression: 'cf.waf.credential_check.username_and_password_leaked' }),
  pol('POL-1008', 'THREATINTEL', 4, 'AUTHENTICATION DETECTED', 'challenge', { expression: 'cf.waf.auth_detected' }),
  pol('POL-1009', 'THREATINTEL', 4, 'USERNAME AND PASSWORD LEAK (log copy)', 'log', { expression: 'cf.waf.credential_check.username_and_password_leaked', targetText: 'Remain in Log, review for removal' }),
  pol('POL-2001', 'BOTMGT', 4, 'DEFINITE BOTS - BOT BAND 1', 'challenge', { expression: 'cf.bot_management.score eq 1 and not cf.bot_management.verified_bot and not cf.bot_management.static_resource' }),
  pol('POL-2002', 'BOTMGT', 4, 'LIKELY BOTS - BOT BAND 2 - 10', 'challenge', { expression: 'cf.bot_management.score ge 2 and cf.bot_management.score le 10 and not cf.bot_management.verified_bot and not cf.bot_management.static_resource' }),
  pol('POL-2003', 'BOTMGT', 4, 'LIKELY BOTS - BOT BAND 11 - 20', 'challenge', { expression: 'cf.bot_management.score ge 11 and cf.bot_management.score le 20 and not cf.bot_management.verified_bot and not cf.bot_management.static_resource' }),
  pol('POL-2004', 'BOTMGT', 4, 'LIKELY BOTS - BOT BAND 21 - 29', 'log', { expression: 'cf.bot_management.score ge 21 and cf.bot_management.score le 29 and not cf.bot_management.verified_bot and not cf.bot_management.static_resource', targetText: 'Remain in Log, review for removal' }),
  pol('POL-2005', 'BOTMGT', 4, 'KNOWN BOTS', 'challenge', { expression: 'cf.client.bot' }),
  pol('POL-3001', 'WAFAS', 4, 'WAF ATTACK SCORE - ATTACK LIKELY CLASS', 'challenge', { expression: 'cf.waf.score.class eq "likely_attack"' }),
  pol('POL-3002', 'WAFAS', 4, 'WAF ATTACK SCORE - ATTACK CLASS', 'challenge', { expression: 'cf.waf.score.class eq "attack"' }),
  pol('POL-3003', 'WAFAS', 4, 'WAF ATTACK SCORE - SQLI ATTACK SCORE 1-20', 'challenge', { expression: 'cf.waf.score.sqli ge 1 and cf.waf.score.sqli le 20 and not cf.bot_management.verified_bot' }),
  pol('POL-3004', 'WAFAS', 4, 'WAF ATTACK SCORE - XSS ATTACK SCORE 1-20', 'challenge', { expression: 'cf.waf.score.xss ge 1 and cf.waf.score.xss le 20 and not cf.bot_management.verified_bot' }),
  pol('POL-3005', 'WAFAS', 4, 'WAF ATTACK SCORE - RCE ATTACK SCORE 1-20', 'log', { expression: 'cf.waf.score.rce ge 1 and cf.waf.score.rce le 20 and not cf.bot_management.verified_bot', targetText: 'Remain in Log, review for removal' }),
];

export const RATE_RULES: RateRule[] = [
  { id: 'RL-01', title: 'Tiered Rate Limit -500/5mins', requests: 500, period: 300, natAware: true },
  { id: 'RL-02', title: 'Tiered Rate Limit -800/5mins', requests: 800, period: 300, natAware: true },
  { id: 'RL-03', title: 'Tiered Rate Limit -1000/5mins', requests: 1000, period: 300, natAware: true },
  { id: 'RL-04', title: 'Verified Bot -350/1min', requests: 350, period: 60, natAware: false, expression: 'cf.bot_management.verified_bot' },
  { id: 'RL-05', title: 'Definite Bot -350/1min', requests: 350, period: 60, natAware: false, expression: 'cf.client.bot' },
  { id: 'RL-06', title: 'DDoS (app+API) - general traffic edge guard (10s)', requests: 1000, period: 10, natAware: false, expression: 'not http.request.method in {"PUT" "DELETE" "POST"}' },
  { id: 'RL-07', title: 'DDoS (app+API) - POST/PUT/DELETE edge guard (10s)', requests: 250, period: 10, natAware: false, expression: 'http.request.method in {"PUT" "DELETE" "POST"}' },
  { id: 'RL-08', title: 'Origin (app+API) - sustained 4xx/5xx error rate backstop (10s)', requests: 220, period: 10, natAware: false, expression: 'true', counting: 'http.response.code ge 400 and http.response.code le 599' },
  { id: 'RL-09', title: 'Origin (app+API) - 403/404 scanning/forced-browsing guard (3 min)', requests: 8, period: 180, natAware: false, expression: 'true', counting: 'http.response.code in {403 404}' },
  { id: 'RL-10', title: 'Bot score (app+API) - likely-automated traffic guard, score < 30 (1 min)', requests: 40, period: 60, natAware: false, expression: 'cf.bot_management.score gt 0 and cf.bot_management.score lt 30 and not cf.bot_management.verified_bot' },
  { id: 'RL-11', title: 'Bot score (app+API) - automated traffic guard, score < 10 (1 min)', requests: 10, period: 60, natAware: false, expression: 'cf.bot_management.score gt 0 and cf.bot_management.score lt 10 and not cf.bot_management.verified_bot' },
  { id: 'RL-12', title: 'Zone-wide (app+API) - per-visitor burst ceiling, NAT-aware, throttle (15 min)', requests: 200, period: 900, natAware: true, expression: 'true' },
  { id: 'RL-13', title: 'Zone-wide (app+API) - per-visitor sustained ceiling, NAT-aware, throttle (30 min)', requests: 400, period: 1800, natAware: true, expression: 'true' },
  { id: 'RL-14', title: 'REST API-only - anonymous read traffic (GET/HEAD) guard (1 min)', requests: 500, period: 60, natAware: false, block: true, expression: 'http.request.uri.path contains "/api" and http.request.method in {"GET" "HEAD"}' },
  { id: 'RL-15', title: 'REST API-only - anonymous write traffic (POST/PUT/PATCH/DELETE) guard (1 min)', requests: 100, period: 60, natAware: false, block: true, expression: 'http.request.uri.path contains "/api" and http.request.method in {"POST" "PUT" "PATCH" "DELETE"}' },
];

/** One granular check of the policy: its key, label, why, and what group it is shown under. */
export interface PolicyEntry { id: string; group: string; title: string; why: string; item: TemplateItem }

const CUSTOM = 'http_request_firewall_custom';
const RATE = 'http_ratelimit';
const key = (phase: string, id: string, what: string) => `check:${phase}:${id.toLowerCase().replace(/-/g, '_')}_${what}`;
const w = (field: string, match: CheckWhen['match'], value: string): CheckWhen => ({ field, match, value });
const per = (s: number) => (s % 60 ? `${s} s` : s === 60 ? '1 min' : `${s / 60} min`);

/** How a policy rule is found in a zone: its expression (or, for bot detection IDs, every one of its IDs). */
function identify(r: PolicyRule): CheckWhen[] {
  if (r.detectionIds) return [w('expression', 'contains', 'cf.bot_management.detection_ids'), w('expression', 'contains_all', r.detectionIds)];
  return [w('expression', 'contains', r.expression!)];
}
const ACTION: Record<PolicyTarget, CheckWhen> = {
  challenge_then_block: w('action', 'one_of', 'managed_challenge, block'),
  challenge: w('action', 'equals', 'managed_challenge'),
  log: w('action', 'equals', 'log'),
  block_after_review: w('action', 'one_of', 'log, block'),
};

function polEntries(r: PolicyRule): PolicyEntry[] {
  const group = `Phase ${r.phase} · ${r.category}`;
  const name = `${r.id} ${r.title}`;
  const id = identify(r);
  const ids = r.detectionIds ? r.detectionIds.split(' ').length : 0;
  const found = r.detectionIds ? `a custom rule matching all ${ids} of its bot detection IDs` : `a custom rule with ${r.expression}`;
  const item = (what: string, path: string, when: CheckWhen[]): TemplateItem => ({ item: key(CUSTOM, r.id, what), kind: 'rule', path, expected: '', match: 'present', check: { phase: CUSTOM, when } });
  const out: PolicyEntry[] = [
    { id: `${r.id}-exists`, group, title: `${name}: the rule exists`, why: `Found as ${found}, wherever it sits.`, item: item('exists', `${name} · exists`, id) },
    { id: `${r.id}-action`, group, title: `${name}: action is ${r.targetText}`, why: r.target === 'block_after_review' ? 'Log while it is reviewed, Block once exceptions are in: either passes.' : r.target === 'challenge_then_block' ? 'Managed Challenge first, Block once the review shows it is safe: either passes.' : `Target action: ${r.targetText}.`,
      item: item('action', `${name} · action ${r.targetText}`, [...id, ACTION[r.target]]) },
  ];
  if (r.target === 'challenge' || r.target === 'challenge_then_block') {
    out.push({ id: `${r.id}-api`, group, title: `${name}: API paths are excluded`, why: 'API and machine-to-machine clients cannot solve a challenge: the rule must leave the API endpoints out (a "not … http.request.uri.path" condition). Change the path to your API list.',
      item: item('api_excluded', `${name} · API paths excluded`, [...id, w('expression', 'contains_all', 'not http.request.uri.path')]) });
  }
  return out;
}

function rateEntries(r: RateRule): PolicyEntry[] {
  const group = 'Rate limiting (RL)';
  const name = `${r.id} ${r.title}`;
  // Found by its threshold (and its expression, when it has one besides the zone's hostnames).
  const id = [...(r.expression && r.expression !== 'true' ? [w('expression', 'contains', r.expression)] : r.expression === 'true' ? [w('expression', 'equals', 'true')] : []),
    w('ratelimit.requests_per_period', 'equals', String(r.requests)), w('ratelimit.period', 'equals', String(r.period))];
  const item = (what: string, path: string, when: CheckWhen[]): TemplateItem => ({ item: key(RATE, r.id, what), kind: 'rule', path, expected: '', match: 'present', check: { phase: RATE, when } });
  const out: PolicyEntry[] = [
    { id: `${r.id}-exists`, group, title: `${name}: ${r.requests} requests per ${per(r.period)}`, why: `A rate limiting rule${r.expression && r.expression !== 'true' ? ` on ${r.expression}` : r.expression === 'true' ? ' on every request' : ' on the zone’s hostnames'} with this threshold.`, item: item('exists', `${name} · ${r.requests}/${per(r.period)}`, id) },
    { id: `${r.id}-by`, group, title: `${name}: counts per ${r.natAware ? 'IP with NAT support' : 'IP address'}`, why: r.natAware ? 'NAT aware: visitors behind one address (offices, mobile networks) are counted apart (cf.unique_visitor_id).' : 'Counted per client IP address (ip.src).',
      item: item('counted_by', `${name} · counted by ${r.natAware ? 'IP with NAT support' : 'IP'}`, [...id, w('ratelimit.characteristics', 'contains', r.natAware ? 'cf.unique_visitor_id' : 'ip.src')]) },
    { id: `${r.id}-origin`, group, title: `${name}: counts origin requests only`, why: 'Cache hits are not counted: only requests that reach the origin.', item: item('origin_only', `${name} · origin requests only`, [...id, w('ratelimit.requests_to_origin', 'equals', 'true')]) },
    { id: `${r.id}-throttle`, group, title: `${name}: throttles (no fixed block period)`, why: 'Throttle: requests above the rate are acted on, requests under it pass (mitigation timeout 0).', item: item('throttle', `${name} · throttle`, [...id, w('ratelimit.mitigation_timeout', 'equals', '0')]) },
  ];
  if (r.counting) out.push({ id: `${r.id}-counting`, group, title: `${name}: counts only ${r.counting}`, why: 'The counting expression differs from the match expression: only these responses count toward the rate.', item: item('counting', `${name} · counting ${r.counting}`, [...id, w('ratelimit.counting_expression', 'contains', r.counting)]) });
  out.push(r.block
    ? { id: `${r.id}-action`, group, title: `${name}: Log now, Block when enforced (never a challenge)`, why: 'API clients cannot solve a challenge: this rule uses Block with throttling once enforced.', item: item('action', `${name} · action Log or Block`, [...id, w('action', 'one_of', 'log, block')]) }
    : { id: `${r.id}-action`, group, title: `${name}: starts in Log mode`, why: 'Every rate limiting rule starts in Log; the target action and final threshold are agreed after the Log review.', item: item('action', `${name} · action Log`, [...id, w('action', 'equals', 'log')]) });
  return out;
}

export const POLICY_LIBRARY: PolicyEntry[] = [...POLICY_RULES.flatMap(polEntries), ...RATE_RULES.flatMap(rateEntries)];
