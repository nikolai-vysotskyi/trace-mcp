import { SetupWizard, isOnboardingDone, ONBOARDING_KEY } from './SetupWizard';

export { SetupWizard, isOnboardingDone, ONBOARDING_KEY };

export interface GuardOnboardingProps {
  onClose: () => void;
}

export function GuardOnboarding({ onClose }: GuardOnboardingProps) {
  return <SetupWizard onClose={onClose} />;
}
