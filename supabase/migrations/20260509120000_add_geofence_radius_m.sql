-- Check-in radius (meters) shared across all worksites for a company.
-- Apply in Supabase: SQL Editor → New query → paste → Run, or `supabase db push`.

ALTER TABLE public.subscriptions
ADD COLUMN IF NOT EXISTS geofence_radius_m integer NOT NULL DEFAULT 50
CHECK (geofence_radius_m >= 10 AND geofence_radius_m <= 2000);

COMMENT ON COLUMN public.subscriptions.geofence_radius_m IS 'Geofence radius in meters; employees must be within this distance of a site to check in.';
