// Type declarations for asset imports
declare module "*.png" {
  const content: string;
  export default content;
}

declare module "*.jpg" {
  const content: string;
  export default content;
}

declare module "*.jpeg" {
  const content: string;
  export default content;
}

declare module "*.gif" {
  const content: string;
  export default content;
}

declare module "*.svg" {
  const content: string;
  export default content;
}

declare module "*.webp" {
  const content: string;
  export default content;
}

// For CSS modules
declare module "*.module.css" {
  const classes: { [key: string]: string };
  export default classes;
}

// For JSON files
declare module "*.json" {
  const content: any;
  export default content;
}