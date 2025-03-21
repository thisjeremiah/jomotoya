import { cn } from "@/utils/cn";

export default function Home() {
  return (
    <div className="font-sans">
      <div className="flex flex-col justify-center items-center h-screen">
        <Heading className="leading-none mx-auto">jomotoya</Heading>
      </div>
    </div>
  );
}

function Heading(props: React.ComponentProps<"h1">) {
  return (
    <h1
      {...props}
      className={cn(
        "font-sans font-bold tracking-widest uppercase",
        "text-6xl md:text-9xl",
        props.className
      )}
    />
  );
}
