export type Block={id?:string;type:string;attrs?:Record<string,unknown>;content?:Block[]};
export const CORE_BLOCKS=[
 {name:"core/paragraph",title:"Paragraph",category:"text"},{name:"core/heading",title:"Heading",category:"text"},
 {name:"core/list",title:"List",category:"text"},{name:"core/quote",title:"Quote",category:"text"},{name:"core/code",title:"Code",category:"text"},
 {name:"core/image",title:"Image",category:"media"},{name:"core/gallery",title:"Gallery",category:"media"},
 {name:"core/button",title:"Button",category:"design"},{name:"core/separator",title:"Separator",category:"design"},
 {name:"core/html",title:"HTML",category:"advanced"},{name:"core/group",title:"Group",category:"layout"},{name:"core/columns",title:"Columns",category:"layout"}
];
export function parseBlocks(content:string):Block[]{try{const value=JSON.parse(content);return Array.isArray(value)?value:[]}catch{return content?[{type:"core/paragraph",attrs:{text:content}}]:[]}}
