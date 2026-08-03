import { HIGH_RISK_THRESHOLD } from './risk-score.js';

// Dead exports removed: comparePlayers, getPlayerTrends, searchMembers — leftovers
// from the retired /player and /compare command set, confirmed zero callers via grep.

/**
 * Calculate clan health score (0-100)
 */
export function calculateClanHealth(members, history, scored) {
  let score = 100;
  const issues = [];

  if (!Array.isArray(members) || members.length === 0) {
    return { score: 0, grade: 'F', issues: ['⚠️ No clan roster data available'], metrics: { avgParticipation: 0, inactive: 0, highRisk: 0, avgDonations: 0, repeatOffenders: 0 } };
  }

  // Members with too little tracked history read as 0% participation purely for lack of
  // data (e.g. the first day of a fresh war/colosseum week, before anyone's had a chance to
  // play) — not genuine inactivity. minHistoryDays: 3 matches the threshold ops.js already
  // uses when computing `scored`. Without this, a brand-new tracking window can crater the
  // score to near-zero for the whole clan simultaneously, which is exactly what was
  // happening: 35/35 members with 2 tracked days produced a 40/100 "F" health score.
  const reliable = scored.filter(m => !m.inGrace && (m.historyDays ?? 0) >= 3);

  // Participation (40 points)
  let avgParticipation = 0;
  if (reliable.length === 0) {
    issues.push('ℹ️ Not enough tracked history yet to score participation this window');
  } else {
    avgParticipation = reliable.reduce((sum, m) => sum + (m.warParticipationRate ?? 0), 0) / reliable.length;
    if (avgParticipation < 50) {
      score -= 40;
      issues.push('❌ Critical: Very low war participation (<50%)');
    } else if (avgParticipation < 70) {
      score -= 25;
      issues.push('⚠️ Warning: Below average participation (<70%)');
    } else if (avgParticipation < 85) {
      score -= 10;
      issues.push('⚡ Room for improvement: Participation below 85%');
    } else {
      issues.push('✅ Excellent war participation');
    }
  }

  // Inactive members (20 points) — same reliable-history gate: someone with insufficient
  // history isn't "inactive", there's just no data on them yet.
  const inactive = scored.filter(m => !m.inGrace && (m.historyDays ?? 0) >= 3 && m.warParticipationRate === 0).length;
  const inactivePercent = (inactive / members.length) * 100;

  if (inactivePercent > 20) {
    score -= 20;
    issues.push(`❌ Too many inactive members (${inactive}/${members.length})`);
  } else if (inactivePercent > 10) {
    score -= 10;
    issues.push(`⚠️ Some inactive members (${inactive}/${members.length})`);
  } else {
    issues.push('✅ Low inactive count');
  }

  // High risk members (20 points)
  const highRisk = scored.filter(m => m.risk >= HIGH_RISK_THRESHOLD && !m.inGrace).length;
  const highRiskPercent = (highRisk / members.length) * 100;
  
  if (highRiskPercent > 15) {
    score -= 20;
    issues.push(`❌ Many high-risk members (${highRisk})`);
  } else if (highRiskPercent > 8) {
    score -= 10;
    issues.push(`⚠️ Several high-risk members (${highRisk})`);
  } else {
    issues.push('✅ Few high-risk members');
  }
  
  // Donations (10 points)
  const totalDonations = members.reduce((sum, m) => sum + Number(m.donations ?? 0), 0);
  const avgDonations = totalDonations / members.length;
  
  if (avgDonations < 5) {
    score -= 10;
    issues.push('⚠️ Low donation activity');
  } else if (avgDonations >= 15) {
    issues.push('✅ Strong donation culture');
  }
  
  // Repeat offenders (10 points)
  const repeatOffenders = scored.filter(m => m.repeatOffender).length;
  if (repeatOffenders > 5) {
    score -= 10;
    issues.push(`⚠️ ${repeatOffenders} repeat offenders detected`);
  } else if (repeatOffenders === 0) {
    issues.push('✅ No repeat offenders');
  }
  
  score = Math.max(0, Math.min(100, score));
  
  return {
    score,
    grade: score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 60 ? 'D' : 'F',
    issues,
    metrics: {
      avgParticipation: Math.round(avgParticipation),
      inactive,
      highRisk,
      avgDonations: Math.round(avgDonations),
      repeatOffenders
    }
  };
}
