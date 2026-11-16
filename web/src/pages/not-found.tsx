import { Compass } from '@phosphor-icons/react';
import { Link } from 'react-router';
import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';

export default function NotFoundPage() {
  return (
    <EmptyState
      icon={Compass}
      title="页面不存在"
      action={
        <Button asChild variant="secondary">
          <Link to="/repositories">返回仓库列表</Link>
        </Button>
      }
    />
  );
}
