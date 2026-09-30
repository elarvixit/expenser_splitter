-- Add an expense split equally, by hand (normally you'd just use the website).
-- Fill in the values in the "declare" section, then Run. If anything is wrong
-- (unknown group or person), it stops with a message and saves nothing.
do $$
declare
  v_token  uuid   := 'YOUR-GROUP-TOKEN';        -- the part after #g= in the share link
  v_payer  text   := 'Asha';                    -- who paid
  v_people text[] := array['Asha', 'Bilal', 'Chen'];  -- who shares it (equally)
  v_amount bigint := 45050;                     -- in PAISE: ₹450.50 = 45050
  v_desc   text   := 'Chai';                    -- what it was for
  v_cat    text   := 'Food';                    -- Food, Travel, Stay, Shopping, Entertainment, Bills, Other, or your own

  g uuid; payer_id text; r record; i int := 0;
  n int := array_length(v_people, 1);
  eid text := 'e_sql_' || substr(md5(random()::text), 1, 10);
begin
  select id into g from tharun_expense_splitter_groups where token = v_token;
  if g is null then raise exception 'No group with that token'; end if;
  select id into payer_id from tharun_expense_splitter_members where group_id = g and name = v_payer;
  if payer_id is null then raise exception 'Payer "%" is not in this group', v_payer; end if;

  insert into tharun_expense_splitter_expenses (group_id, id, description, category, paid_by, amount, split_mode, created_at)
  values (g, eid, v_desc, nullif(trim(v_cat), ''), payer_id, v_amount, 'equal', now());

  -- equal shares; leftover paise go one each to the first people listed (same as the app)
  for r in select m.id from unnest(v_people) with ordinality as p(name, ord)
           join tharun_expense_splitter_members m on m.group_id = g and m.name = p.name
           order by p.ord loop
    insert into tharun_expense_splitter_expense_splits (group_id, expense_id, member_id, amount)
    values (g, eid, r.id, v_amount / n + case when i < v_amount % n then 1 else 0 end);
    i := i + 1;
  end loop;
  if i <> n then raise exception 'Some of those people are not in this group'; end if;

  update tharun_expense_splitter_groups set version = version + 1, updated_at = now() where id = g;
  raise notice 'Added "%" (₹%) to the group', v_desc, v_amount / 100.0;
end $$;
