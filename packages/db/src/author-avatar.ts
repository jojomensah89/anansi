import { sql, type SQL } from "drizzle-orm";

/** saved_at is the available capture/import stamp, not the post publication date. */
export function authorAvatarProjection(row: SQL): SQL {
  const latest = sql`(select coalesce('/api/media/' || a.stored_key, latest.author_avatar)
    from items latest left join author_avatars a on a.origin_url = latest.author_avatar
    where latest.source = ${row}.source and latest.author_handle = ${row}.author_handle
      and latest.author_avatar is not null and latest.author_avatar <> ''
    order by latest.saved_at desc, latest.id desc limit 1)`;
  return sql`case when ${row}.author_handle is null or ${row}.author_handle = ''
    then coalesce((select '/api/media/' || a.stored_key from author_avatars a
      where a.origin_url = ${row}.author_avatar), ${row}.author_avatar)
    else ${latest} end`;
}
