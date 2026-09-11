import React from 'react';
import type { ResumeProfileSummary } from '../shared/types';

interface ResumeProfileSelectorProps {
  profiles: ResumeProfileSummary['profiles'];
  activeProfileId: string;
  disabled: boolean;
  onSwitch: (id: string) => void;
}

export function ResumeProfileSelector({ profiles, activeProfileId, disabled, onSwitch }: ResumeProfileSelectorProps) {
  const active = profiles.find(profile => profile.id === activeProfileId) ?? profiles[0];
  return <section className="resume-profile-selector" aria-labelledby="resume-profile-selector-label">
    <span id="resume-profile-selector-label">当前简历</span>
    <label className="resume-profile-selector-control"><span className="popup-sr-only">切换当前简历</span><select aria-label="切换当前简历" value={active?.id || ''} disabled={disabled || profiles.length === 0} onChange={event => onSwitch(event.target.value)}>{profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label>
  </section>;
}
