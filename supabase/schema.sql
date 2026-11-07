-- ヨミドーパ: いいね・フォロー・広告申し込みのためのデータベース(Supabase / PostgreSQL)
-- Supabase の SQL Editor に、このファイルの中身をそのまま貼って実行する。何度実行しても壊れないように書いてある。
--
-- 方針
-- - いいねは「一文」単位。作品ID + 本文の中の位置(開始・終了)で一文を表す。
-- - いいねとフォローは公開情報(ほかの人のいいね欄を見られる)。アプリの画面でもそう案内する。
-- - 広告の申し込みは本人と運営だけが見られる。掲載する広告(ads)は運営だけが書きこめる。
-- - 運営の作業(広告の承認など)は Supabase のダッシュボードから行う(service_role)。

-- ===== プロフィール =====
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  handle text unique not null check (handle ~ '^[a-z0-9_]{3,20}$'),
  display_name text not null check (char_length(display_name) between 1 and 30),
  bio text not null default '' check (char_length(bio) <= 160),
  created_at timestamptz not null default now()
);

-- ===== 一文へのいいね =====
create table if not exists public.likes (
  user_id uuid not null references public.profiles (id) on delete cascade,
  work_id text not null check (work_id ~ '^[0-9]{1,6}$'),
  sent_start int not null check (sent_start >= 0),
  sent_end int not null check (sent_end > sent_start and sent_end - sent_start <= 2000),
  created_at timestamptz not null default now(),
  primary key (user_id, work_id, sent_start)
);
create index if not exists likes_work_idx on public.likes (work_id, sent_start);
create index if not exists likes_recent_idx on public.likes (user_id, created_at desc);

-- ===== フォロー =====
create table if not exists public.follows (
  follower uuid not null references public.profiles (id) on delete cascade,
  followee uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower, followee),
  check (follower <> followee)
);
create index if not exists follows_followee_idx on public.follows (followee);

-- ===== ブロック(ブロックした人のいいねは自分のタイムラインに出さない・フォローもされない) =====
create table if not exists public.blocks (
  blocker uuid not null references public.profiles (id) on delete cascade,
  blocked uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker, blocked),
  check (blocker <> blocked)
);

-- ===== 広告の申し込み(本人と運営だけが見る) =====
create table if not exists public.ad_applications (
  id bigint generated always as identity primary key,
  applicant uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  kind text not null check (kind in ('book', 'general')),
  advertiser_name text not null check (char_length(advertiser_name) between 1 and 60),
  contact_email text not null check (contact_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  title text not null check (char_length(title) between 1 and 60),
  body text not null check (char_length(body) between 1 and 600),
  link_url text not null check (link_url ~ '^https://'),
  rights_confirmed boolean not null default false,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'withdrawn')),
  review_note text not null default '',
  created_at timestamptz not null default now(),
  -- 本の宣伝は、権利の確認が必須
  check (kind <> 'book' or rights_confirmed)
);

-- ===== 掲載する広告(運営が承認・入金確認のあとに作る。みんなが読める) =====
create table if not exists public.ads (
  id bigint generated always as identity primary key,
  application_id bigint references public.ad_applications (id) on delete set null,
  kind text not null check (kind in ('book', 'general')),
  advertiser_name text not null,
  title text not null,
  body text not null,
  link_url text not null check (link_url ~ '^https://'),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at)
);

-- ===== 行ごとの権限(RLS) =====
alter table public.profiles enable row level security;
alter table public.likes enable row level security;
alter table public.follows enable row level security;
alter table public.blocks enable row level security;
alter table public.ad_applications enable row level security;
alter table public.ads enable row level security;

drop policy if exists "profiles: だれでも読める" on public.profiles;
create policy "profiles: だれでも読める" on public.profiles for select using (true);
drop policy if exists "profiles: 本人が作る" on public.profiles;
create policy "profiles: 本人が作る" on public.profiles for insert to authenticated with check (id = auth.uid());
drop policy if exists "profiles: 本人が直す" on public.profiles;
create policy "profiles: 本人が直す" on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists "likes: だれでも読める" on public.likes;
create policy "likes: だれでも読める" on public.likes for select using (true);
drop policy if exists "likes: 本人が付ける" on public.likes;
create policy "likes: 本人が付ける" on public.likes for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "likes: 本人が外す" on public.likes;
create policy "likes: 本人が外す" on public.likes for delete to authenticated using (user_id = auth.uid());

-- ブロックされているか(ブロックの記録は本人しか読めないので、確認だけをこの関数で行う)
create or replace function public.is_blocked(p_blocker uuid, p_blocked uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.blocks where blocker = p_blocker and blocked = p_blocked);
$$;
revoke all on function public.is_blocked(uuid, uuid) from public;
grant execute on function public.is_blocked(uuid, uuid) to authenticated;

drop policy if exists "follows: だれでも読める" on public.follows;
create policy "follows: だれでも読める" on public.follows for select using (true);
drop policy if exists "follows: 本人がフォローする" on public.follows;
create policy "follows: 本人がフォローする" on public.follows for insert to authenticated
  with check (
    follower = auth.uid()
    and not public.is_blocked(followee, follower)
  );
drop policy if exists "follows: 本人が外す" on public.follows;
create policy "follows: 本人が外す" on public.follows for delete to authenticated using (follower = auth.uid());

drop policy if exists "blocks: 本人だけ読める" on public.blocks;
create policy "blocks: 本人だけ読める" on public.blocks for select to authenticated using (blocker = auth.uid());
drop policy if exists "blocks: 本人がブロックする" on public.blocks;
create policy "blocks: 本人がブロックする" on public.blocks for insert to authenticated with check (blocker = auth.uid());
drop policy if exists "blocks: 本人が外す" on public.blocks;
create policy "blocks: 本人が外す" on public.blocks for delete to authenticated using (blocker = auth.uid());

drop policy if exists "ad_applications: 本人だけ読める" on public.ad_applications;
create policy "ad_applications: 本人だけ読める" on public.ad_applications for select to authenticated using (applicant = auth.uid());
drop policy if exists "ad_applications: 本人が申し込む" on public.ad_applications;
create policy "ad_applications: 本人が申し込む" on public.ad_applications for insert to authenticated
  with check (applicant = auth.uid() and status = 'pending' and review_note = '');
-- 申し込みの更新(承認・却下)は運営だけ(ポリシーなし = service_role だけ)

drop policy if exists "ads: 掲載期間中はだれでも読める" on public.ads;
create policy "ads: 掲載期間中はだれでも読める" on public.ads for select using (now() between starts_at and ends_at);
-- ads の書きこみは運営だけ(ポリシーなし = service_role だけ)

-- ブロックしたときは、相手からのフォローを外す
create or replace function public.on_block() returns trigger language plpgsql security definer set search_path = public as $$
begin
  delete from public.follows where follower = new.blocked and followee = new.blocker;
  return new;
end $$;
drop trigger if exists on_block on public.blocks;
create trigger on_block after insert on public.blocks for each row execute function public.on_block();

-- ===== 集計と、タイムライン用の関数 =====

-- 一文ごとのいいね数(本物の人数だけ)
create or replace function public.sentence_like_counts(p_work text)
returns table (sent_start int, sent_end int, likes bigint)
language sql stable set search_path = public as $$
  select l.sent_start, min(l.sent_end), count(*) from public.likes l
  where l.work_id = p_work group by l.sent_start;
$$;

-- 「この作品をいいねした人は、こちらの作品もいいねしています」
-- p_work に1つでもいいねした人たちが、ほかにいいねした作品を、人数の多い順に返す
create or replace function public.also_liked(p_work text, p_limit int default 5)
returns table (work_id text, people bigint)
language sql stable set search_path = public as $$
  with fans as (select distinct user_id from public.likes where work_id = p_work)
  select l.work_id, count(distinct l.user_id) as people
  from public.likes l join fans f using (user_id)
  where l.work_id <> p_work
  group by l.work_id
  order by people desc, l.work_id
  limit least(greatest(p_limit, 1), 20);
$$;

-- フォローしている人の最近のいいね(タイムラインに流す用)。ブロックした人は出さない
create or replace function public.following_likes(p_limit int default 30, p_before timestamptz default now())
returns table (user_id uuid, handle text, display_name text, work_id text, sent_start int, sent_end int, created_at timestamptz)
language sql stable set search_path = public as $$
  select l.user_id, p.handle, p.display_name, l.work_id, l.sent_start, l.sent_end, l.created_at
  from public.follows f
  join public.likes l on l.user_id = f.followee
  join public.profiles p on p.id = l.user_id
  where f.follower = auth.uid()
    and l.created_at < p_before
    and not exists (select 1 from public.blocks b where b.blocker = auth.uid() and b.blocked = l.user_id)
  order by l.created_at desc
  limit least(greatest(p_limit, 1), 100);
$$;

-- ある人のいいね欄(新しい順)
create or replace function public.user_likes(p_handle text, p_limit int default 50, p_before timestamptz default now())
returns table (work_id text, sent_start int, sent_end int, created_at timestamptz)
language sql stable set search_path = public as $$
  select l.work_id, l.sent_start, l.sent_end, l.created_at
  from public.likes l join public.profiles p on p.id = l.user_id
  where p.handle = p_handle and l.created_at < p_before
  order by l.created_at desc
  limit least(greatest(p_limit, 1), 100);
$$;

-- 人ごとの数(フォロー数・フォロワー数・いいね数)
create or replace function public.profile_stats(p_handle text)
returns table (following bigint, followers bigint, likes bigint)
language sql stable set search_path = public as $$
  select
    (select count(*) from public.follows f join public.profiles p on p.id = f.follower where p.handle = p_handle),
    (select count(*) from public.follows f join public.profiles p on p.id = f.followee where p.handle = p_handle),
    (select count(*) from public.likes l join public.profiles p on p.id = l.user_id where p.handle = p_handle);
$$;

grant execute on function public.sentence_like_counts(text) to anon, authenticated;
grant execute on function public.also_liked(text, int) to anon, authenticated;
grant execute on function public.following_likes(int, timestamptz) to authenticated;
grant execute on function public.user_likes(text, int, timestamptz) to anon, authenticated;
grant execute on function public.profile_stats(text) to anon, authenticated;
