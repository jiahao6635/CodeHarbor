import { Link } from 'react-router';
import { useAbility } from '@/auth/session';
import { Alert } from '@/components/ui/alert';

export function RepositoryCreatePermission() {
  const { hasPat } = useAbility();
  if (hasPat) return null;
  return (
    <Alert tone="warning" title="需要绑定云效 PAT" className="mb-4">
      <Link to="/onboarding">绑定你的云效 PAT</Link>，即可接入有权限克隆的仓库。
    </Alert>
  );
}
