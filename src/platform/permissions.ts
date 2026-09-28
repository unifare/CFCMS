import { Env, SessionUser } from "../shared/types";

export async function can(env:Env,user:SessionUser,permission:string){
  if(user.role==="admin") return true;
  const row=await env.DB.prepare("SELECT enabled FROM role_permissions WHERE role=? AND permission=? LIMIT 1").bind(user.role,permission).first<any>();
  return !!row?.enabled;
}
export async function requirePermission(env:Env,user:SessionUser,permission:string){
  return can(env,user,permission);
}
