-- Add a person to a group by hand (normally you'd just use the website).
-- 1. Replace YOUR-GROUP-TOKEN (the part after #g= in the share link) in BOTH places.
-- 2. Replace the name. Names must be unique within the group (case-insensitive), max 24 characters.
begin;

insert into tharun_expense_splitter_members (group_id, id, name, position)
select g.id,
       'm_sql_' || substr(md5(random()::text), 1, 10),
       'Ravi',
       (select coalesce(max(m.position), 0) + 1 from tharun_expense_splitter_members m where m.group_id = g.id)
from tharun_expense_splitter_groups g
where g.token = 'YOUR-GROUP-TOKEN';

-- Always bump the version with a manual change, so open apps reload instead of overwriting it.
update tharun_expense_splitter_groups
set version = version + 1, updated_at = now()
where token = 'YOUR-GROUP-TOKEN';

commit;
