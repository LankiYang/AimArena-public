const dt=1/30, speed=5.2;

export function walkEdge(walker, from, to, jump=false) {
  walker.reset([from.x,from.y-.00999,from.z]);walker.grounded=true;
  let foot=walker.getFoot();
  for(let frame=0;frame<Math.ceil(Math.hypot(to.x-from.x,to.z-from.z)/(speed*dt))+(jump?14:3);frame++){
    const dx=to.x-foot.x,dz=to.z-foot.z,dist=Math.hypot(dx,dz);
    if(dist<.01)break;
    const divisor=Math.max(dist,speed*dt);
    foot=walker.update({x:dx/divisor,z:dz/divisor},dt,{speed,jump:jump&&frame===0});
  }
  if(Math.hypot(to.x-foot.x,to.z-foot.z)>.05||walker.fellOut)return null;
  for(let frame=0;frame<40&&!walker.grounded;frame++)foot=walker.update({x:0,z:0},dt,{speed});
  return walker.grounded&&!walker.fellOut&&Math.abs(foot.y-to.y)<.06&&Math.hypot(to.x-foot.x,to.z-foot.z)<.05?foot:null;
}
