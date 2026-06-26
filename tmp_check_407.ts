import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
(async () => {
  const propertyId = 'AX_DVI_HOTEL_407';
  const hotel = await prisma.dvi_hotel.findFirst({ where: { axisrooms_property_id: propertyId, axisrooms_enabled: 1, deleted: { not: true } }, select: { hotel_id: true, hotel_name: true } });
  if (!hotel) throw new Error('hotel not found');
  const rooms = await prisma.dvi_hotel_rooms.findMany({ where: { hotel_id: hotel.hotel_id, deleted: 0, status: 1 }, select: { room_ID: true, room_title: true, room_ref_code: true, room_type_id: true }, orderBy: { room_ID: 'asc' } as any });
  const typeIds = [...new Set(rooms.map((r:any) => Number(r.room_type_id)).filter(Boolean))];
  const types = await prisma.dvi_hotel_roomtype.findMany({ where: { room_type_id: { in: typeIds } as any }, select: { room_type_id: true, room_type_title: true } as any });
  const typeMap = new Map(types.map((t:any)=>[Number(t.room_type_id), String(t.room_type_title||'')]));
  console.log(JSON.stringify({ hotel, rooms: rooms.map((r:any)=>({ roomId: Number(r.room_ID), roomRefCode: r.room_ref_code, roomTitle: r.room_title, roomTypeId: Number(r.room_type_id), roomTypeTitle: typeMap.get(Number(r.room_type_id)) || '', apiName: (typeMap.get(Number(r.room_type_id)) || r.room_title || 'Room') })) }, null, 2));
  await prisma.$disconnect();
})();
