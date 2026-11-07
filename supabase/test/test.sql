-- schema.sql の権限(RLS)と関数のテスト。run.sh から実行する。
\set ON_ERROR_STOP on
\set A '\'11111111-1111-1111-1111-111111111111\''
\set B '\'22222222-2222-2222-2222-222222222222\''
\set C '\'33333333-3333-3333-3333-333333333333\''

insert into auth.users values (:A), (:B), (:C);

create or replace function pg_temp.expect_fail(sql text, label text) returns void language plpgsql as $$
begin
  begin
    execute sql;
  exception when others then
    raise notice 'OK (拒否された): %', label;
    return;
  end;
  raise exception 'NG: 通ってしまった: %', label;
end $$;
create or replace function pg_temp.affected(sql text) returns int language plpgsql as $$
declare n int;
begin
  execute sql;
  get diagnostics n = row_count;
  return n;
end $$;
create or replace function pg_temp.expect(cond boolean, label text) returns void language plpgsql as $$
begin
  if not cond then raise exception 'NG: %', label; end if;
  raise notice 'OK: %', label;
end $$;

-- ===== A としてログイン =====
set role authenticated;
select set_config('request.jwt.claim.sub', :A, false);
insert into public.profiles (id, handle, display_name) values (:A, 'alice', 'アリス');
select pg_temp.expect_fail($$insert into public.profiles (id, handle, display_name) values ('22222222-2222-2222-2222-222222222222', 'bob_fake', 'なりすまし')$$, '他人のプロフィールは作れない');
insert into public.likes (user_id, work_id, sent_start, sent_end) values (:A, '92', 10, 40), (:A, '127', 0, 30);
select pg_temp.expect_fail($$insert into public.likes (user_id, work_id, sent_start, sent_end) values ('22222222-2222-2222-2222-222222222222', '92', 10, 40)$$, '他人の名前でいいねできない');
select pg_temp.expect_fail($$insert into public.likes (user_id, work_id, sent_start, sent_end) values ('11111111-1111-1111-1111-111111111111', '92', 10, 40)$$, '同じ一文に2回いいねできない');
insert into public.ad_applications (kind, advertiser_name, contact_email, title, body, link_url, rights_confirmed)
  values ('book', 'アリス書房', 'alice@example.com', '私の本', '本文の一部', 'https://example.com/book', true);
select pg_temp.expect_fail($$insert into public.ad_applications (kind, advertiser_name, contact_email, title, body, link_url, rights_confirmed) values ('book', 'x', 'x@example.com', 't', 'b', 'https://example.com', false)$$, '権利の確認がない本の宣伝は申し込めない');
select pg_temp.expect_fail($$insert into public.ad_applications (kind, advertiser_name, contact_email, title, body, link_url, status) values ('general', 'x', 'x@example.com', 't', 'b', 'https://example.com', 'approved')$$, '自分で承認ずみにはできない');
select pg_temp.expect(pg_temp.affected($$update public.ad_applications set status = 'approved'$$) = 0, '申し込みを自分で承認できない');
select pg_temp.expect_fail($$insert into public.ads (kind, advertiser_name, title, body, link_url, starts_at, ends_at) values ('general', 'x', 't', 'b', 'https://example.com', now(), now() + interval '1 day')$$, '広告を勝手に掲載できない');

-- ===== B としてログイン =====
select set_config('request.jwt.claim.sub', :B, false);
insert into public.profiles (id, handle, display_name) values (:B, 'bob', 'ボブ');
insert into public.likes (user_id, work_id, sent_start, sent_end) values (:B, '92', 10, 40), (:B, '628', 5, 50), (:B, '127', 0, 30);
select pg_temp.expect((select count(*) from public.ad_applications) = 0, '他人の広告申し込みは見えない');
select pg_temp.expect((select count(*) from public.likes where user_id = :A) = 2, '他人のいいね欄は見られる');
select pg_temp.expect(pg_temp.affected($$delete from public.likes where user_id = '11111111-1111-1111-1111-111111111111'$$) = 0, '他人のいいねは消せない');
insert into public.follows (follower, followee) values (:B, :A);
select pg_temp.expect_fail($$insert into public.follows (follower, followee) values ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222')$$, '他人の代わりにフォローできない');
select pg_temp.expect((select likes from public.sentence_like_counts('92') where sent_start = 10) = 2, '一文のいいね数 = 本物の人数');
select pg_temp.expect((select count(*) from public.following_likes()) = 2, 'フォローした人のいいねがタイムライン用に取れる');

-- ===== C としてログイン =====
select set_config('request.jwt.claim.sub', :C, false);
insert into public.profiles (id, handle, display_name) values (:C, 'carol', 'キャロル');
insert into public.likes (user_id, work_id, sent_start, sent_end) values (:C, '92', 0, 9), (:C, '628', 5, 50);
-- 92 をいいねした人(A, B, C)がほかにいいねした作品: 628 は B と C で2人、127 は A と B で2人
select pg_temp.expect((select people from public.also_liked('92') where work_id = '628') = 2, 'この作品をいいねした人はこちらもいいね(628)');
select pg_temp.expect((select count(*) from public.also_liked('92') where work_id = '92') = 0, 'おすすめに同じ作品は出ない');
select pg_temp.expect((select following from public.profile_stats('bob')) = 1 and (select followers from public.profile_stats('alice')) = 1, 'フォロー数・フォロワー数');
select pg_temp.expect((select count(*) from public.user_likes('bob')) = 3, 'ある人のいいね欄');

-- ===== A が B をブロック → B のフォローが外れる =====
select set_config('request.jwt.claim.sub', :A, false);
insert into public.blocks (blocker, blocked) values (:A, :B);
reset role;
select pg_temp.expect((select count(*) from public.follows where follower = :B and followee = :A) = 0, 'ブロックするとフォローが外れる');
set role authenticated;
select set_config('request.jwt.claim.sub', :B, false);
select pg_temp.expect_fail($$insert into public.follows (follower, followee) values ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111')$$, 'ブロックされた人はフォローできない');

-- ===== ログインしていない人(anon) =====
reset role;
set role anon;
select set_config('request.jwt.claim.sub', '', false);
select pg_temp.expect((select count(*) from public.likes) = 7, 'ログインなしでもいいねの数は読める');
select pg_temp.expect_fail($$insert into public.likes (user_id, work_id, sent_start, sent_end) values ('11111111-1111-1111-1111-111111111111', '1', 0, 5)$$, 'ログインなしではいいねできない');
select pg_temp.expect((select count(*) from public.ad_applications) = 0, 'ログインなしでは広告申し込みは見えない');
reset role;
\echo ALL_OK
