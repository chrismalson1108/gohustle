// Client-facing shapes produced by shared/transforms.js, typed for the web app.

export type BookingStatus =
  | "pending"
  | "confirmed"
  | "completed"
  | "verified"
  | "declined"
  | "cancelled";

export type AmendmentStatus = "none" | "pending" | "accepted" | "declined";

export type PayType = "flat" | "hourly";

export interface Slot {
  id: string;
  label: string;
  taken: boolean;
  startsAt: string | null;
}

export interface PosterMini {
  name: string;
  avatarInitial: string;
  avatarUrl: string | null;
  rating: number;
  reviewCount: number;
  verified: boolean;
}

export interface Review {
  id: string;
  author: string;
  rating: number;
  text: string;
  date: string;
}

export interface Job {
  id: string;
  posterId: string;
  title: string;
  category: string;
  pay: number;
  payType: PayType;
  location: string;
  description: string;
  urgent: boolean;
  estimatedHours: number;
  status: string;
  photos: string[];
  recurrence: string;
  lat: number | null;
  lng: number | null;
  postedAt: string;
  poster: PosterMini;
  slots: Slot[];
  requirements: string[];
  reviews: Review[];
  _distanceMi?: number | null;
}

export interface EarnerMini {
  id: string;
  name: string;
  avatarInitial: string;
  avatarUrl: string | null;
  rating: number;
  reviewCount: number;
}

export interface BookingJobMini {
  id: string;
  title: string;
  pay: number;
  payType: PayType;
}

export interface Booking {
  id: string;
  jobId: string;
  slotId: string | null;
  slotLabel: string | null;
  counterOffer: number | null;
  status: BookingStatus;
  paymentMethod: string | null;
  earnerRating: number | null;
  reviewText: string | null;
  completedAt: string | null;
  earnerDone: boolean;
  posterDone: boolean;
  posterRating: number | null;
  posterReview: string | null;
  amendmentNote: string | null;
  amendmentStatus: AmendmentStatus;
  completionPhotos: string[];
  startsAt: string | null;
  tipAmount: number;
  earner: EarnerMini | null;
  job: BookingJobMini | null;
}

export interface Profile {
  id: string;
  name: string;
  avatarInitial: string;
  avatarUrl: string | null;
  role: "earner" | "poster" | "both";
  rating: number;
  reviewCount: number;
  posterRating: number;
  posterReviewCount: number;
  memberSince: string;
  bio: string | null;
  username: string | null;
  city: string | null;
  skills: string[];
  radiusMiles: number;
  verified: boolean;
  xp: number;
  streakDays: number;
  earningsToday: number;
  earningsWeek: number;
  earningsTotal: number;
  weeklyEarningGoal: number;
  weeklyJobsGoal: number;
  weeklyJobsDone: number;
  onboardingDone: boolean;
}

export interface Toast {
  icon?: string;
  title: string;
  message?: string;
}
