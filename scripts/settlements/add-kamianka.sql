INSERT INTO public.settlement (
    id, kind, name, territorial_community, district, region, lon, lat
)
VALUES (
    94886, 'Village', 'Кам’янка', 'Дворічанська', 'Куп’янський', 'Харківська',
    37.832401, 49.977469
)
ON CONFLICT (id) DO NOTHING;
