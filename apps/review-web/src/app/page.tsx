import { ReviewRoomPage } from './review-room-page';

export const dynamic = 'force-dynamic';

export default async function Page(): Promise<React.ReactNode> {
  return <ReviewRoomPage />;
}
